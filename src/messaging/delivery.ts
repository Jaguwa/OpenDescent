/**
 * Messaging — Encrypted message creation, delivery, and store-and-forward
 *
 * Message lifecycle:
 * 1. Sender creates a Message object
 * 2. Message is serialized and encrypted for the recipient
 * 3. Wrapped in a MessageEnvelope with metadata, authTag, and signature
 * 4. If recipient is online: deliver directly via libp2p stream
 * 5. If recipient is offline: distribute to nearby peers who hold the
 *    message and deliver when recipient appears
 * 6. Decrypted messages are stored in conversation history
 */

import * as crypto from 'crypto';
import type {
  Message,
  MessageEnvelope,
  Identity,
  ContentType,
  PeerId,
} from '../types/index.js';
import { encryptForPeer, decryptFromPeer, type EncryptedPayload } from '../crypto/encryption.js';
import { sign, verify, publicKeyToPeerId } from '../crypto/identity.js';
import { DecentraNode, PROTOCOLS } from '../network/node.js';
import { LocalStore, type StoredMessage } from '../storage/store.js';

const FORWARD_REDUNDANCY = 3;
const DEFAULT_TTL = 7 * 24 * 60 * 60;

export class MessagingService {
  private node: DecentraNode;
  private store: LocalStore;
  private identity: Identity;
  private onMessageCallbacks: ((message: Message) => void)[] = [];

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;
    this.identity = node.getIdentity();

    // Listen for incoming messages
    this.node.on('message:received', async (event) => {
      if (event.data instanceof Uint8Array) {
        await this.handleIncomingMessage(event.data);
      }
    });

    // When a peer connects (profile exchanged), deliver pending messages
    this.node.on('peer:connected', async (event) => {
      if (event.peerId) {
        // Store their profile for future lookups
        if (event.data && typeof event.data === 'object' && 'peerId' in (event.data as any)) {
          await this.store.storePeerProfile(event.data as any);
        }
        await this.deliverPendingMessages(event.peerId);
      }
    });
  }

  onMessage(callback: (message: Message) => void): void {
    this.onMessageCallbacks.push(callback);
  }

  async sendTextMessage(recipientId: PeerId, text: string, replyTo?: string): Promise<string> {
    const message: Message = {
      messageId: crypto.randomUUID(),
      from: this.node.getPeerId(),
      to: recipientId,
      type: 'text_message' as ContentType,
      body: text,
      attachments: [],
      timestamp: Date.now(),
      replyTo,
    };

    return this.sendMessage(message, recipientId);
  }

  async sendMediaMessage(
    recipientId: PeerId,
    contentType: ContentType,
    contentId: string,
    caption?: string,
  ): Promise<string> {
    const message: Message = {
      messageId: crypto.randomUUID(),
      from: this.node.getPeerId(),
      to: recipientId,
      type: contentType,
      body: caption || '',
      attachments: [contentId],
      timestamp: Date.now(),
    };

    return this.sendMessage(message, recipientId);
  }

  private async sendMessage(message: Message, recipientId: PeerId): Promise<string> {
    // Get recipient's profile (need their encryption public key)
    const recipientProfile = await this.store.getPeerProfile(recipientId)
      || this.node.getKnownPeer(recipientId);

    if (!recipientProfile) {
      throw new Error(`Unknown recipient: ${recipientId}. Wait for them to connect or add them as a contact.`);
    }

    // Serialize, encrypt, envelope, sign
    const serialized = new TextEncoder().encode(JSON.stringify(message));
    const encrypted = encryptForPeer(serialized, recipientProfile.encryptionPublicKey);
    const envelope = this.createEnvelope(message, encrypted, recipientId);

    // Store envelope
    await this.store.storeMessage(envelope);

    // Store in conversation history
    const conversationId = this.getConversationId(this.node.getPeerId(), recipientId);
    await this.store.storeHistoryMessage({
      messageId: message.messageId,
      conversationId,
      from: message.from,
      to: message.to,
      body: message.body,
      type: message.type,
      attachments: message.attachments,
      timestamp: message.timestamp,
      status: 'sent',
    });

    // Try direct delivery
    const delivered = await this.tryDirectDelivery(recipientId, envelope);

    if (delivered) {
      await this.store.updateMessageStatus(conversationId, message.messageId, 'delivered');
    } else {
      console.log(`[Messaging] Recipient ${recipientId} offline, using store-and-forward`);
      await this.storeAndForward(recipientId, envelope);
    }

    console.log(`[Messaging] Message ${message.messageId} sent (direct: ${delivered})`);
    return message.messageId;
  }

  private async tryDirectDelivery(recipientId: PeerId, envelope: MessageEnvelope): Promise<boolean> {
    const envelopeData = new TextEncoder().encode(JSON.stringify(serializeEnvelopeForWire(envelope)));
    const response = await this.node.sendToPeer(recipientId, PROTOCOLS.MESSAGE, envelopeData);

    if (response) {
      return new TextDecoder().decode(response) === 'ACK';
    }
    return false;
  }

  private async storeAndForward(recipientId: PeerId, envelope: MessageEnvelope): Promise<void> {
    // Sealed sender: encrypt the entire envelope for the recipient so relay peers
    // see NOTHING — no from, no to, no contentTypeHint, no fingerprint. Just an opaque blob.
    const recipientProfile = await this.store.getPeerProfile(recipientId)
      || this.node.getKnownPeer(recipientId);

    if (!recipientProfile) {
      // Can't seal without recipient key — fall back to legacy (rare edge case)
      await this.store.queuePendingMessage(recipientId, envelope);
      const connectedPeers = this.node.getConnectedPeers();
      let forwarded = 0;
      for (const peer of connectedPeers) {
        if (!peer.decentraId || peer.decentraId === recipientId) continue;
        if (forwarded >= FORWARD_REDUNDANCY) break;
        const forwardData = new TextEncoder().encode(JSON.stringify({
          type: 'store_forward',
          recipientId,
          envelope: serializeEnvelopeForWire(envelope),
        }));
        const response = await this.node.sendToPeer(peer.decentraId, PROTOCOLS.MESSAGE, forwardData);
        if (response) forwarded++;
      }
      return;
    }

    // Seal: encrypt the entire serialized envelope for the recipient
    const envelopeJson = JSON.stringify(serializeEnvelopeForWire(envelope));
    const sealed = encryptForPeer(new TextEncoder().encode(envelopeJson), recipientProfile.encryptionPublicKey);
    const sealedStr = JSON.stringify({
      ciphertext: Buffer.from(sealed.ciphertext).toString('base64'),
      nonce: Buffer.from(sealed.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(sealed.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(sealed.authTag).toString('base64'),
    });

    // Store locally as sealed
    await this.store.queueSealedMessage(recipientId, envelope.messageId, sealedStr);

    // Forward sealed blob to relay peers — they see only recipientId + opaque blob
    const connectedPeers = this.node.getConnectedPeers();
    let forwarded = 0;

    for (const peer of connectedPeers) {
      if (!peer.decentraId || peer.decentraId === recipientId) continue;
      if (forwarded >= FORWARD_REDUNDANCY) break;

      const forwardData = new TextEncoder().encode(JSON.stringify({
        type: 'store_forward_sealed',
        recipientId,
        messageId: envelope.messageId,
        sealed: sealedStr,
      }));

      const response = await this.node.sendToPeer(peer.decentraId, PROTOCOLS.MESSAGE, forwardData);
      if (response) forwarded++;
    }

    if (forwarded > 0) {
      console.log(`[Messaging] Forwarded sealed message to ${forwarded} peers for store-and-forward`);
    }
  }

  /** Allow external handlers (like GroupManager) to intercept messages */
  private groupMessageHandler?: (raw: any) => Promise<boolean>;

  setGroupMessageHandler(handler: (raw: any) => Promise<boolean>): void {
    this.groupMessageHandler = handler;
  }

  private async handleIncomingMessage(data: Uint8Array): Promise<void> {
    try {
      const raw = JSON.parse(new TextDecoder().decode(data));

      if (raw.type === 'store_forward_sealed') {
        await this.handleSealedStoreForward(raw);
        return;
      }
      if (raw.type === 'store_forward') {
        await this.handleStoreForwardRequest(raw);
        return;
      }

      // Check if this is a group control message
      if (raw.type && raw.groupId && this.groupMessageHandler) {
        const handled = await this.groupMessageHandler(raw);
        if (handled) return;
      }

      const envelope = deserializeEnvelopeFromWire(raw);

      if (envelope.to !== this.node.getPeerId()) {
        return;
      }

      // Verify sender signature — reject messages from unknown or unverifiable senders
      const senderProfile = this.node.getKnownPeer(envelope.from);
      if (!senderProfile) {
        console.warn(`[Messaging] Dropping message from unknown sender ${envelope.from} — PEER_EXCHANGE required first`);
        return;
      }
      if (envelope.signature.length === 0) {
        console.warn(`[Messaging] Dropping unsigned message from ${envelope.from}`);
        return;
      }
      const verifyObj: Record<string, unknown> = {
        messageId: envelope.messageId,
        from: envelope.from,
        to: envelope.to,
        encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
        nonce: Buffer.from(envelope.nonce).toString('base64'),
        ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
        authTag: Buffer.from(envelope.authTag).toString('base64'),
        timestamp: envelope.timestamp,
        ttl: envelope.ttl,
        contentTypeHint: envelope.contentTypeHint,
      };
      if (envelope.senderKeyFingerprint) {
        verifyObj.senderKeyFingerprint = envelope.senderKeyFingerprint;
      }
      const dataToVerify = new TextEncoder().encode(JSON.stringify(verifyObj));
      if (!verify(dataToVerify, envelope.signature, senderProfile.publicKey)) {
        console.warn(`[Messaging] Invalid signature from ${envelope.from} — dropping message`);
        return;
      }

      await this.store.storeMessage(envelope);

      // Decrypt
      const decrypted = decryptFromPeer(
        {
          ciphertext: envelope.encryptedPayload,
          nonce: envelope.nonce,
          ephemeralPublicKey: envelope.ephemeralPublicKey,
          authTag: envelope.authTag,
        },
        this.identity.encryptionPrivateKey,
      );

      const message: Message = JSON.parse(new TextDecoder().decode(decrypted));

      // Store in conversation history
      const conversationId = this.getConversationId(message.from, message.to);
      await this.store.storeHistoryMessage({
        messageId: message.messageId,
        conversationId,
        from: message.from,
        to: message.to,
        body: message.body,
        type: message.type,
        attachments: message.attachments,
        timestamp: message.timestamp,
        status: 'delivered',
      });

      for (const callback of this.onMessageCallbacks) {
        callback(message);
      }
    } catch (error) {
      console.error(`[Messaging] Failed to process incoming message:`, error);
    }
  }

  private async handleStoreForwardRequest(raw: any): Promise<void> {
    const recipientId = raw.recipientId;
    if (!recipientId || typeof recipientId !== 'string') return;
    const envelope = deserializeEnvelopeFromWire(raw.envelope);

    // Verify envelope signature before storing — reject unverifiable senders
    // When `from` is redacted, use the senderKeyFingerprint to find the sender
    let senderProfile = this.node.getKnownPeer(envelope.from);
    if (!senderProfile && envelope.senderKeyFingerprint && envelope.from === 'redacted') {
      // Look up sender by fingerprint match against known peers
      for (const peer of this.node.getAllKnownPeers()) {
        const fp = crypto.createHash('sha256').update(peer.publicKey).digest('hex').slice(0, 16);
        if (fp === envelope.senderKeyFingerprint) {
          senderProfile = peer;
          break;
        }
      }
    }
    if (!senderProfile || envelope.signature.length === 0) {
      console.warn(`[Messaging] Rejected store-forward: unverifiable sender (fingerprint: ${envelope.senderKeyFingerprint || 'none'})`);
      return;
    }
    // Reconstruct the original signed data (with real sender PeerId, not 'redacted')
    const dataToVerify = new TextEncoder().encode(JSON.stringify({
      messageId: envelope.messageId,
      from: senderProfile.peerId,
      to: envelope.to,
      encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
      nonce: Buffer.from(envelope.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(envelope.authTag).toString('base64'),
      timestamp: envelope.timestamp,
      ttl: envelope.ttl,
      contentTypeHint: envelope.contentTypeHint,
      senderKeyFingerprint: envelope.senderKeyFingerprint,
    }));
    if (!verify(dataToVerify, envelope.signature, senderProfile.publicKey)) {
      console.warn(`[Messaging] Rejected store-forward: invalid signature (fingerprint: ${envelope.senderKeyFingerprint})`);
      return;
    }
    // Restore the real sender PeerId before storing for later delivery
    envelope.from = senderProfile.peerId;

    await this.store.queuePendingMessage(recipientId, envelope);
    console.log(`[Messaging] Holding message ${envelope.messageId} for ${recipientId}`);
  }

  /**
   * Handle sealed store-forward: relay stores an opaque encrypted blob.
   * The relay cannot see sender, recipient metadata, content type — only the routing recipientId.
   */
  private async handleSealedStoreForward(raw: any): Promise<void> {
    const recipientId = raw.recipientId;
    const messageId = raw.messageId;
    const sealed = raw.sealed;
    if (!recipientId || !messageId || !sealed) return;

    // If WE are the recipient, unseal and process directly
    if (recipientId === this.node.getPeerId()) {
      try {
        const sealedObj = typeof sealed === 'string' ? JSON.parse(sealed) : sealed;
        const decrypted = decryptFromPeer(
          {
            ciphertext: new Uint8Array(Buffer.from(sealedObj.ciphertext, 'base64')),
            nonce: new Uint8Array(Buffer.from(sealedObj.nonce, 'base64')),
            ephemeralPublicKey: new Uint8Array(Buffer.from(sealedObj.ephemeralPublicKey, 'base64')),
            authTag: new Uint8Array(Buffer.from(sealedObj.authTag, 'base64')),
          },
          this.identity.encryptionPrivateKey,
        );
        const envelopeRaw = JSON.parse(new TextDecoder().decode(decrypted));
        // Re-process as a normal incoming message
        await this.handleIncomingMessage(new TextEncoder().encode(JSON.stringify(envelopeRaw)));
      } catch (e) {
        console.warn(`[Messaging] Failed to unseal message: ${(e as Error).message}`);
      }
      return;
    }

    // We are a relay — store the sealed blob without inspecting it
    await this.store.queueSealedMessage(recipientId, messageId, typeof sealed === 'string' ? sealed : JSON.stringify(sealed));
    console.log(`[Messaging] Holding sealed message ${messageId} for ${recipientId}`);
  }

  private async deliverPendingMessages(decentraId: PeerId): Promise<void> {
    // Deliver legacy pending messages
    const pending = await this.store.getPendingMessages(decentraId);
    for (const envelope of pending) {
      const delivered = await this.tryDirectDelivery(decentraId, envelope);
      if (delivered) {
        await this.store.removePendingMessage(decentraId, envelope.messageId);
      }
    }

    // Deliver sealed messages — send the sealed blob, recipient unseals it
    const sealed = await this.store.getSealedMessages(decentraId);
    for (const msg of sealed) {
      const deliveryData = new TextEncoder().encode(JSON.stringify({
        type: 'store_forward_sealed',
        recipientId: decentraId,
        messageId: msg.messageId,
        sealed: msg.sealed,
      }));
      const response = await this.node.sendToPeer(decentraId, PROTOCOLS.MESSAGE, deliveryData);
      if (response && new TextDecoder().decode(response) === 'ACK') {
        await this.store.removeSealedMessage(decentraId, msg.messageId);
      }
    }

    const total = pending.length + sealed.length;
    if (total > 0) {
      console.log(`[Messaging] Delivered ${total} pending messages to ${decentraId} (${sealed.length} sealed)`);
    }
  }

  private createEnvelope(
    message: Message,
    encrypted: EncryptedPayload,
    recipientId: PeerId,
  ): MessageEnvelope {
    // Compute sender key fingerprint (truncated SHA-256 of public key)
    const fingerprint = crypto.createHash('sha256')
      .update(this.identity.publicKey)
      .digest('hex')
      .slice(0, 16);

    const envelopeData: Omit<MessageEnvelope, 'signature'> = {
      messageId: message.messageId,
      from: this.node.getPeerId(),
      to: recipientId,
      encryptedPayload: encrypted.ciphertext,
      nonce: encrypted.nonce,
      ephemeralPublicKey: encrypted.ephemeralPublicKey,
      authTag: encrypted.authTag,
      timestamp: Date.now(),
      ttl: DEFAULT_TTL,
      contentTypeHint: message.type,
      senderKeyFingerprint: fingerprint,
    };

    const dataToSign = new TextEncoder().encode(JSON.stringify({
      ...envelopeData,
      encryptedPayload: Buffer.from(envelopeData.encryptedPayload).toString('base64'),
      nonce: Buffer.from(envelopeData.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(envelopeData.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(envelopeData.authTag).toString('base64'),
    }));
    const signature = sign(dataToSign, this.identity.privateKey);

    return { ...envelopeData, signature };
  }

  /**
   * Derive a consistent conversation ID between two peers.
   * Sorted so both sides get the same ID.
   */
  private getConversationId(peerA: string, peerB: string): string {
    return [peerA, peerB].sort().join(':');
  }
}

// ─── Wire Serialization ──────────────────────────────────────────────────────

function serializeEnvelopeForWire(envelope: MessageEnvelope): Record<string, unknown> {
  return {
    ...envelope,
    encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
    nonce: Buffer.from(envelope.nonce).toString('base64'),
    ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
    authTag: Buffer.from(envelope.authTag).toString('base64'),
    signature: Buffer.from(envelope.signature).toString('base64'),
  };
}

function deserializeEnvelopeFromWire(raw: any): MessageEnvelope {
  return {
    ...raw,
    encryptedPayload: new Uint8Array(Buffer.from(raw.encryptedPayload, 'base64')),
    nonce: new Uint8Array(Buffer.from(raw.nonce, 'base64')),
    ephemeralPublicKey: new Uint8Array(Buffer.from(raw.ephemeralPublicKey, 'base64')),
    authTag: new Uint8Array(Buffer.from(raw.authTag, 'base64')),
    signature: new Uint8Array(Buffer.from(raw.signature, 'base64')),
  };
}
