/**
 * Messaging — Encrypted message creation, delivery, and store-and-forward
 *
 * Message lifecycle:
 * 1. Sender creates a Message object
 * 2. Message is serialized and encrypted for the recipient
 * 3. Wrapped in a MessageEnvelope with metadata and signature
 * 4. If recipient is online: deliver directly via libp2p stream
 * 5. If recipient is offline: distribute to nearby peers who will
 *    hold the message and deliver when recipient appears
 *
 * Store-and-forward is crucial for a P2P network where peers go
 * offline frequently. Multiple peers hold the message to ensure
 * delivery even if some forwarding peers go offline too.
 */

import * as crypto from 'crypto';
import type {
  Message,
  MessageEnvelope,
  Identity,
  PeerProfile,
  ContentType,
  PeerId,
} from '../types/index.js';
import { encryptForPeer, decryptFromPeer, type EncryptedPayload } from '../crypto/encryption.js';
import { sign, verify, publicKeyToPeerId } from '../crypto/identity.js';
import { DecentraNode, PROTOCOLS } from '../network/node.js';
import { LocalStore } from '../storage/store.js';

/** How many peers should hold a store-and-forward message */
const FORWARD_REDUNDANCY = 3;

/** Default message TTL: 7 days */
const DEFAULT_TTL = 7 * 24 * 60 * 60;

export class MessagingService {
  private node: DecentraNode;
  private store: LocalStore;
  private identity: Identity;
  private onMessageCallback?: (message: Message) => void;

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

    // When a peer connects, check if we have pending messages for them
    this.node.on('peer:connected', async (event) => {
      if (event.peerId) {
        await this.deliverPendingMessages(event.peerId);
      }
    });
  }

  /**
   * Register a callback for received messages.
   */
  onMessage(callback: (message: Message) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Send a text message to a peer.
   */
  async sendTextMessage(recipientId: PeerId, text: string, replyTo?: string): Promise<string> {
    const message: Message = {
      messageId: generateMessageId(),
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

  /**
   * Send a media message (voice note, video note, etc).
   * The media content should already be stored in the distributed
   * storage layer — this message just references it by ContentId.
   */
  async sendMediaMessage(
    recipientId: PeerId,
    contentType: ContentType,
    contentId: string,
    caption?: string,
  ): Promise<string> {
    const message: Message = {
      messageId: generateMessageId(),
      from: this.node.getPeerId(),
      to: recipientId,
      type: contentType,
      body: caption || '',
      attachments: [contentId],
      timestamp: Date.now(),
    };

    return this.sendMessage(message, recipientId);
  }

  /**
   * Core message sending logic.
   */
  private async sendMessage(message: Message, recipientId: PeerId): Promise<string> {
    // Get recipient's profile (we need their encryption public key)
    const recipientProfile = await this.store.getPeerProfile(recipientId);
    if (!recipientProfile) {
      throw new Error(`Unknown recipient: ${recipientId}. Add them as a contact first.`);
    }

    // Serialize and encrypt the message
    const serialized = new TextEncoder().encode(JSON.stringify(message));
    const encrypted = encryptForPeer(serialized, recipientProfile.encryptionPublicKey);

    // Create the envelope
    const envelope = this.createEnvelope(message, encrypted, recipientId);

    // Store our own copy
    await this.store.storeMessage(envelope);

    // Try direct delivery first
    const delivered = await this.tryDirectDelivery(recipientId, envelope);

    if (!delivered) {
      // Recipient is offline — use store-and-forward
      console.log(`[Messaging] Recipient ${recipientId} offline, using store-and-forward`);
      await this.storeAndForward(recipientId, envelope);
    }

    console.log(`[Messaging] Message ${message.messageId} sent (direct: ${delivered})`);
    return message.messageId;
  }

  /**
   * Try to deliver a message directly to the recipient.
   */
  private async tryDirectDelivery(recipientId: PeerId, envelope: MessageEnvelope): Promise<boolean> {
    const envelopeData = new TextEncoder().encode(JSON.stringify({
      ...envelope,
      encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
      nonce: Buffer.from(envelope.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
      signature: Buffer.from(envelope.signature).toString('base64'),
    }));

    const response = await this.node.sendToPeer(recipientId, PROTOCOLS.MESSAGE, envelopeData);

    if (response) {
      const ack = new TextDecoder().decode(response);
      return ack === 'ACK';
    }

    return false;
  }

  /**
   * Distribute a message to nearby peers for store-and-forward delivery.
   */
  private async storeAndForward(recipientId: PeerId, envelope: MessageEnvelope): Promise<void> {
    // Store locally first (we'll also try to deliver when recipient appears)
    await this.store.queuePendingMessage(recipientId, envelope);

    // In a full implementation, we'd also push to FORWARD_REDUNDANCY
    // other peers who are closest to the recipient in the DHT keyspace.
    // Those peers will also hold the message and attempt delivery.
    //
    // For the prototype, we rely on our own node delivering when the
    // recipient connects to us directly.

    const connectedPeers = this.node.getConnectedPeers();
    let forwarded = 0;

    for (const peerId of connectedPeers) {
      if (peerId === recipientId) continue;
      if (forwarded >= FORWARD_REDUNDANCY) break;

      // Ask this peer to hold the message for the recipient
      const envelopeData = new TextEncoder().encode(JSON.stringify({
        type: 'store_forward',
        recipientId,
        envelope: {
          ...envelope,
          encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
          nonce: Buffer.from(envelope.nonce).toString('base64'),
          ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
          signature: Buffer.from(envelope.signature).toString('base64'),
        },
      }));

      const response = await this.node.sendToPeer(peerId, PROTOCOLS.MESSAGE, envelopeData);
      if (response) forwarded++;
    }

    console.log(`[Messaging] Forwarded to ${forwarded} peers for store-and-forward`);
  }

  /**
   * Handle an incoming message (either direct or forwarded).
   */
  private async handleIncomingMessage(data: Uint8Array): Promise<void> {
    try {
      const raw = JSON.parse(new TextDecoder().decode(data));

      // Check if this is a store-and-forward request
      if (raw.type === 'store_forward') {
        await this.handleStoreForwardRequest(raw);
        return;
      }

      // This is a direct message to us
      const envelope: MessageEnvelope = {
        ...raw,
        encryptedPayload: new Uint8Array(Buffer.from(raw.encryptedPayload, 'base64')),
        nonce: new Uint8Array(Buffer.from(raw.nonce, 'base64')),
        ephemeralPublicKey: new Uint8Array(Buffer.from(raw.ephemeralPublicKey, 'base64')),
        signature: new Uint8Array(Buffer.from(raw.signature, 'base64')),
      };

      // Verify the message is for us
      if (envelope.to !== this.node.getPeerId()) {
        console.log(`[Messaging] Message not for us, ignoring`);
        return;
      }

      // Store the envelope
      await this.store.storeMessage(envelope);

      // Decrypt the message
      const decrypted = decryptFromPeer(
        {
          ciphertext: envelope.encryptedPayload,
          nonce: envelope.nonce,
          ephemeralPublicKey: envelope.ephemeralPublicKey,
          authTag: new Uint8Array(0), // TODO: include in envelope
        },
        this.identity.encryptionPrivateKey,
      );

      const message: Message = JSON.parse(new TextDecoder().decode(decrypted));
      console.log(`[Messaging] Received message from ${message.from}: ${message.body.slice(0, 50)}...`);

      // Notify the application layer
      if (this.onMessageCallback) {
        this.onMessageCallback(message);
      }
    } catch (error) {
      console.error(`[Messaging] Failed to process incoming message:`, error);
    }
  }

  /**
   * Handle a store-and-forward request from another peer.
   */
  private async handleStoreForwardRequest(raw: any): Promise<void> {
    const recipientId = raw.recipientId;
    const envelope: MessageEnvelope = {
      ...raw.envelope,
      encryptedPayload: new Uint8Array(Buffer.from(raw.envelope.encryptedPayload, 'base64')),
      nonce: new Uint8Array(Buffer.from(raw.envelope.nonce, 'base64')),
      ephemeralPublicKey: new Uint8Array(Buffer.from(raw.envelope.ephemeralPublicKey, 'base64')),
      signature: new Uint8Array(Buffer.from(raw.envelope.signature, 'base64')),
    };

    await this.store.queuePendingMessage(recipientId, envelope);
    console.log(`[Messaging] Holding message ${envelope.messageId} for ${recipientId}`);
  }

  /**
   * Deliver any pending messages we're holding for a peer that just came online.
   */
  private async deliverPendingMessages(peerId: PeerId): Promise<void> {
    const pending = await this.store.getPendingMessages(peerId);
    if (pending.length === 0) return;

    console.log(`[Messaging] Delivering ${pending.length} pending messages to ${peerId}`);

    for (const envelope of pending) {
      const delivered = await this.tryDirectDelivery(peerId, envelope);
      if (delivered) {
        await this.store.removePendingMessage(peerId, envelope.messageId);
      }
    }
  }

  /**
   * Create a signed message envelope.
   */
  private createEnvelope(
    message: Message,
    encrypted: EncryptedPayload,
    recipientId: PeerId,
  ): MessageEnvelope {
    const envelope: Omit<MessageEnvelope, 'signature'> = {
      messageId: message.messageId,
      from: this.node.getPeerId(),
      to: recipientId,
      encryptedPayload: encrypted.ciphertext,
      nonce: encrypted.nonce,
      ephemeralPublicKey: encrypted.ephemeralPublicKey,
      timestamp: Date.now(),
      ttl: DEFAULT_TTL,
      contentTypeHint: message.type,
    };

    // Sign the envelope (excluding signature field)
    const dataToSign = new TextEncoder().encode(JSON.stringify(envelope));
    const signature = sign(dataToSign, this.identity.privateKey);

    return { ...envelope, signature };
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function generateMessageId(): string {
  return crypto.randomUUID();
}
