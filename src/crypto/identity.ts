/**
 * Identity Management — Ed25519 keypair generation and persistence
 *
 * Each user's identity IS their Ed25519 keypair. No usernames, no passwords,
 * no central authority. Your private key is your account — lose it and
 * your identity is gone forever. This is the tradeoff for true decentralization.
 *
 * We also generate X25519 keys for Diffie-Hellman key exchange
 * (used in message encryption).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Identity, PeerProfile } from '../types/index.js';

/**
 * Generate a new identity (Ed25519 signing keypair + X25519 encryption keypair).
 */
export function generateIdentity(displayName?: string): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // Generate separate X25519 keys for encryption
  // In production with libsodium, we'd derive these from the Ed25519 keys
  const encKeyPair = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey: new Uint8Array(publicKey),
    privateKey: new Uint8Array(privateKey),
    encryptionPublicKey: new Uint8Array(encKeyPair.publicKey),
    encryptionPrivateKey: new Uint8Array(encKeyPair.privateKey),
    displayName,
    createdAt: Date.now(),
  };
}

/**
 * Derive a human-readable Peer ID from a public key.
 * Base58-encoded SHA-256 hash truncated to 20 bytes (160 bits).
 */
export function publicKeyToPeerId(publicKey: Uint8Array): string {
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  return base58Encode(hash.subarray(0, 20));
}

/**
 * Save identity to disk encrypted with a user-provided passphrase.
 * Uses scrypt KDF + AES-256-GCM.
 */
export function saveIdentity(identity: Identity, filePath: string, passphrase: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const serialized = JSON.stringify({
    publicKey: Buffer.from(identity.publicKey).toString('base64'),
    privateKey: Buffer.from(identity.privateKey).toString('base64'),
    encryptionPublicKey: Buffer.from(identity.encryptionPublicKey).toString('base64'),
    encryptionPrivateKey: Buffer.from(identity.encryptionPrivateKey).toString('base64'),
    displayName: identity.displayName,
    createdAt: identity.createdAt,
  });

  const salt = crypto.randomBytes(32);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(serialized, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  const envelope = {
    version: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: encrypted,
  };

  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
}

/**
 * Load identity from disk, decrypting with the passphrase.
 */
export function loadIdentity(filePath: string, passphrase: string): Identity {
  const raw = fs.readFileSync(filePath, 'utf8');
  const envelope = JSON.parse(raw);

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(envelope.data, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  const parsed = JSON.parse(decrypted);

  return {
    publicKey: new Uint8Array(Buffer.from(parsed.publicKey, 'base64')),
    privateKey: new Uint8Array(Buffer.from(parsed.privateKey, 'base64')),
    encryptionPublicKey: new Uint8Array(Buffer.from(parsed.encryptionPublicKey, 'base64')),
    encryptionPrivateKey: new Uint8Array(Buffer.from(parsed.encryptionPrivateKey, 'base64')),
    displayName: parsed.displayName,
    createdAt: parsed.createdAt,
  };
}

/**
 * Sign arbitrary data with the identity's Ed25519 private key.
 */
export function sign(data: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const keyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKey),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = crypto.sign(null, Buffer.from(data), keyObject);
  return new Uint8Array(signature);
}

/**
 * Verify a signature against an Ed25519 public key.
 */
export function verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const keyObject = crypto.createPublicKey({
      key: Buffer.from(publicKey),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(data), keyObject, Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Create a signed peer profile from an identity.
 */
export function createPeerProfile(identity: Identity, addresses: string[]): PeerProfile {
  const peerId = publicKeyToPeerId(identity.publicKey);

  const profileData = {
    peerId,
    publicKey: identity.publicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    displayName: identity.displayName,
    addresses,
    lastSeen: Date.now(),
    version: 1,
  };

  const dataToSign = new TextEncoder().encode(JSON.stringify({
    ...profileData,
    publicKey: Buffer.from(profileData.publicKey).toString('base64'),
    encryptionPublicKey: Buffer.from(profileData.encryptionPublicKey).toString('base64'),
  }));
  const signature = sign(dataToSign, identity.privateKey);

  return { ...profileData, signature };
}

/**
 * Verify that a peer profile was signed by the claimed identity.
 */
export function verifyPeerProfile(profile: PeerProfile): boolean {
  const profileData = {
    peerId: profile.peerId,
    publicKey: Buffer.from(profile.publicKey).toString('base64'),
    encryptionPublicKey: Buffer.from(profile.encryptionPublicKey).toString('base64'),
    displayName: profile.displayName,
    addresses: profile.addresses,
    lastSeen: profile.lastSeen,
    version: profile.version,
  };
  const dataToVerify = new TextEncoder().encode(JSON.stringify(profileData));
  return verify(dataToVerify, profile.signature, profile.publicKey);
}

// ─── Base58 Encoding ─────────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer: Uint8Array): string {
  const hex = Buffer.from(buffer).toString('hex');
  if (hex === '') return '1';
  let num = BigInt('0x' + hex);
  const result: string[] = [];

  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result.unshift(BASE58_ALPHABET[remainder]);
  }

  for (const byte of buffer) {
    if (byte === 0) result.unshift('1');
    else break;
  }

  return result.join('') || '1';
}
