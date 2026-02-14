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
import { sign, publicKeyToPeerId } from '../crypto/identity.js';
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
    await this.store.queuePendingMessage(recipientId, envelope);

    // Forward to nearby connected peers for redundancy
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

    if (forwarded > 0) {
      console.log(`[Messaging] Forwarded to ${forwarded} peers for store-and-forward`);
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
    const envelope = deserializeEnvelopeFromWire(raw.envelope);
    await this.store.queuePendingMessage(recipientId, envelope);
    console.log(`[Messaging] Holding message ${envelope.messageId} for ${recipientId}`);
  }

  private async deliverPendingMessages(decentraId: PeerId): Promise<void> {
    const pending = await this.store.getPendingMessages(decentraId);
    if (pending.length === 0) return;

    console.log(`[Messaging] Delivering ${pending.length} pending messages to ${decentraId}`);

    for (const envelope of pending) {
      const delivered = await this.tryDirectDelivery(decentraId, envelope);
      if (delivered) {
        await this.store.removePendingMessage(decentraId, envelope.messageId);
      }
    }
  }

  private createEnvelope(
    message: Message,
    encrypted: EncryptedPayload,
    recipientId: PeerId,
  ): MessageEnvelope {
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
