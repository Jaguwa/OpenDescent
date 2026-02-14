/**
 * End-to-End Encryption — Encrypt/decrypt messages between peers
 *
 * Uses X25519 Diffie-Hellman key exchange + AES-256-GCM.
 *
 * Flow for sending an encrypted message:
 * 1. Generate ephemeral X25519 keypair (new for every message = forward secrecy)
 * 2. Perform DH between ephemeral private key and recipient's public key
 * 3. Derive symmetric key from DH shared secret using HKDF
 * 4. Encrypt message with AES-256-GCM using the derived key
 * 5. Send: encrypted data + ephemeral public key + nonce + authTag
 *
 * Recipient:
 * 1. Perform DH between their private key and sender's ephemeral public key
 * 2. Derive same symmetric key using HKDF
 * 3. Decrypt with AES-256-GCM
 */

import * as crypto from 'crypto';

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  /** AES-GCM nonce (12 bytes) */
  nonce: Uint8Array;
  /** Ephemeral public key used for this message (forward secrecy) */
  ephemeralPublicKey: Uint8Array;
  /** AES-GCM authentication tag (16 bytes) */
  authTag: Uint8Array;
}

/**
 * Encrypt a message for a specific recipient using ephemeral ECDH + AES-256-GCM.
 */
export function encryptForPeer(
  plaintext: Uint8Array,
  recipientEncryptionPubKey: Uint8Array,
): EncryptedPayload {
  // Ephemeral X25519 keypair for forward secrecy
  const ephemeral = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const sharedSecret = performDH(
    Buffer.from(ephemeral.privateKey),
    Buffer.from(recipientEncryptionPubKey),
  );

  const encryptionKey = deriveKey(sharedSecret, 'decentranet-message-v1');

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);

  return {
    ciphertext: new Uint8Array(encrypted),
    nonce: new Uint8Array(nonce),
    ephemeralPublicKey: new Uint8Array(ephemeral.publicKey),
    authTag: new Uint8Array(cipher.getAuthTag()),
  };
}

/**
 * Decrypt a message sent to us.
 */
export function decryptFromPeer(
  payload: EncryptedPayload,
  ourEncryptionPrivateKey: Uint8Array,
): Uint8Array {
  const sharedSecret = performDH(
    Buffer.from(ourEncryptionPrivateKey),
    Buffer.from(payload.ephemeralPublicKey),
  );

  const encryptionKey = deriveKey(sharedSecret, 'decentranet-message-v1');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(payload.nonce),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext)),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

/**
 * Encrypt data with a symmetric group key (for group chats).
 */
export function encryptWithGroupKey(
  plaintext: Uint8Array,
  groupKey: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array; authTag: Uint8Array } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(groupKey), nonce);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);

  return {
    ciphertext: new Uint8Array(encrypted),
    nonce: new Uint8Array(nonce),
    authTag: new Uint8Array(cipher.getAuthTag()),
  };
}

/**
 * Decrypt data with a symmetric group key.
 */
export function decryptWithGroupKey(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  authTag: Uint8Array,
  groupKey: Uint8Array,
): Uint8Array {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(groupKey),
    Buffer.from(nonce),
  );
  decipher.setAuthTag(Buffer.from(authTag));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

/**
 * Generate a random 256-bit symmetric key for group encryption.
 */
export function generateGroupKey(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(32));
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function performDH(ourPrivateKey: Buffer, theirPublicKey: Buffer): Buffer {
  const privKey = crypto.createPrivateKey({
    key: ourPrivateKey,
    format: 'der',
    type: 'pkcs8',
  });
  const pubKey = crypto.createPublicKey({
    key: theirPublicKey,
    format: 'der',
    type: 'spki',
  });

  return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}

function deriveKey(sharedSecret: Buffer, context: string): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    sharedSecret,
    Buffer.from('decentranet-salt-v1'),
    Buffer.from(context),
    32,
  ));
}
