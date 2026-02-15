/**
 * Local Storage Engine — LevelDB-backed key-value store
 *
 * Each peer maintains local storage for:
 * - Shards they're hosting for the network
 * - Their own messages (sent and received)
 * - Known peer profiles
 * - Pending outbound messages (store-and-forward queue)
 */

import { Level } from 'level';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import type { Shard, MessageEnvelope, PeerProfile, ContentManifest, PeerId, AccountBundle, PinnedKey } from '../types/index.js';

/** Decrypted message for conversation history */
export interface StoredMessage {
  messageId: string;
  conversationId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  attachments: string[];
  timestamp: number;
  status: 'sent' | 'delivered' | 'failed';
}

const NS = {
  SHARD: 'shard:',
  MESSAGE: 'msg:',
  PENDING: 'pending:',
  PEER: 'peer:',
  MANIFEST: 'manifest:',
  HISTORY: 'history:',
  IDMAP: 'idmap:',
  GROUP: 'group:',
  META: 'meta:',
  BUNDLE: 'bundle:',
  TOFU: 'tofu:',
} as const;

export class LocalStore {
  private db: Level<string, string>;
  private dataDir: string;
  private maxStorageBytes: number;
  private currentStorageBytes: number = 0;

  constructor(dataDir: string, maxStorageBytes: number) {
    this.dataDir = dataDir;
    this.maxStorageBytes = maxStorageBytes;

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Level(path.join(dataDir, 'store'), { valueEncoding: 'utf8' });
  }

  async open(): Promise<void> {
    await this.db.open();
    await this.calculateStorageUsage();
    console.log(`[Store] Opened. Usage: ${formatBytes(this.currentStorageBytes)} / ${formatBytes(this.maxStorageBytes)}`);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // ─── Shard Storage ──────────────────────────────────────────────────────

  async storeShard(shard: Shard): Promise<boolean> {
    if (this.currentStorageBytes + shard.size > this.maxStorageBytes) {
      console.log(`[Store] Cannot store shard ${shard.shardId}: at capacity`);
      return false;
    }

    const key = NS.SHARD + shard.shardId;
    const value = JSON.stringify({
      ...shard,
      data: Buffer.from(shard.data).toString('base64'),
    });

    await this.db.put(key, value);
    this.currentStorageBytes += shard.size;
    return true;
  }

  async getShard(shardId: string): Promise<Shard | null> {
    try {
      const value = await this.db.get(NS.SHARD + shardId);
      const parsed = JSON.parse(value);
      const data = new Uint8Array(Buffer.from(parsed.data, 'base64'));

      // Verify integrity if hash is present
      if (parsed.hash) {
        const actualHash = crypto.createHash('sha256').update(data).digest('hex');
        if (actualHash !== parsed.hash) {
          console.warn(`[Store] Shard ${shardId} integrity check FAILED — data corrupted`);
          return null;
        }
      }

      return { ...parsed, data };
    } catch {
      return null;
    }
  }

  async hasShard(shardId: string): Promise<boolean> {
    try {
      await this.db.get(NS.SHARD + shardId);
      return true;
    } catch {
      return false;
    }
  }

  async deleteShard(shardId: string): Promise<void> {
    try {
      const shard = await this.getShard(shardId);
      if (shard) {
        await this.db.del(NS.SHARD + shardId);
        this.currentStorageBytes -= shard.size;
      }
    } catch {
      // Already deleted
    }
  }

  async listShardIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const key of this.db.keys({ gte: NS.SHARD, lt: NS.SHARD + '\xFF' })) {
      ids.push(key.slice(NS.SHARD.length));
    }
    return ids;
  }

  // ─── Message Storage ────────────────────────────────────────────────────

  async storeMessage(envelope: MessageEnvelope): Promise<void> {
    const key = NS.MESSAGE + envelope.messageId;
    const value = JSON.stringify(serializeEnvelope(envelope));
    await this.db.put(key, value);
  }

  async getMessage(messageId: string): Promise<MessageEnvelope | null> {
    try {
      const value = await this.db.get(NS.MESSAGE + messageId);
      return deserializeEnvelope(JSON.parse(value));
    } catch {
      return null;
    }
  }

  // ─── Pending Message Queue (Store-and-Forward) ─────────────────────────

  async queuePendingMessage(recipientId: PeerId, envelope: MessageEnvelope): Promise<void> {
    const key = NS.PENDING + recipientId + ':' + envelope.messageId;
    const value = JSON.stringify({
      ...serializeEnvelope(envelope),
      queuedAt: Date.now(),
    });
    await this.db.put(key, value);
    console.log(`[Store] Queued message ${envelope.messageId} for ${recipientId}`);
  }

  async getPendingMessages(recipientId: PeerId): Promise<MessageEnvelope[]> {
    const prefix = NS.PENDING + recipientId + ':';
    const messages: MessageEnvelope[] = [];

    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      messages.push(deserializeEnvelope(JSON.parse(value)));
    }
    return messages;
  }

  async removePendingMessage(recipientId: PeerId, messageId: string): Promise<void> {
    await this.db.del(NS.PENDING + recipientId + ':' + messageId);
  }

  async cleanExpiredMessages(maxAgeSeconds: number): Promise<number> {
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    let cleaned = 0;

    for await (const [key, value] of this.db.iterator({ gte: NS.PENDING, lt: NS.PENDING + '\xFF' })) {
      const parsed = JSON.parse(value);
      if (parsed.queuedAt < cutoff) {
        await this.db.del(key);
        cleaned++;
      }
    }

    if (cleaned > 0) console.log(`[Store] Cleaned ${cleaned} expired pending messages`);
    return cleaned;
  }

  // ─── Peer Profile Storage ──────────────────────────────────────────────

  async storePeerProfile(profile: PeerProfile): Promise<void> {
    const key = NS.PEER + profile.peerId;
    const value = JSON.stringify({
      ...profile,
      publicKey: Buffer.from(profile.publicKey).toString('base64'),
      encryptionPublicKey: Buffer.from(profile.encryptionPublicKey).toString('base64'),
      signature: Buffer.from(profile.signature).toString('base64'),
    });
    await this.db.put(key, value);
  }

  async getPeerProfile(peerId: PeerId): Promise<PeerProfile | null> {
    try {
      const value = await this.db.get(NS.PEER + peerId);
      const parsed = JSON.parse(value);
      return {
        ...parsed,
        publicKey: new Uint8Array(Buffer.from(parsed.publicKey, 'base64')),
        encryptionPublicKey: new Uint8Array(Buffer.from(parsed.encryptionPublicKey, 'base64')),
        signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
      };
    } catch {
      return null;
    }
  }

  async getAllPeerProfiles(): Promise<PeerProfile[]> {
    const profiles: PeerProfile[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.PEER, lt: NS.PEER + '\xFF' })) {
      const parsed = JSON.parse(value);
      profiles.push({
        ...parsed,
        publicKey: new Uint8Array(Buffer.from(parsed.publicKey, 'base64')),
        encryptionPublicKey: new Uint8Array(Buffer.from(parsed.encryptionPublicKey, 'base64')),
        signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
      });
    }
    return profiles;
  }

  // ─── Conversation History (decrypted messages) ─────────────────────────

  /**
   * Store a decrypted message in conversation history.
   * Keyed by conversationId + timestamp for chronological retrieval.
   */
  async storeHistoryMessage(msg: StoredMessage): Promise<void> {
    // Zero-pad timestamp for lexicographic sort
    const tsKey = msg.timestamp.toString().padStart(15, '0');
    const key = NS.HISTORY + msg.conversationId + ':' + tsKey + ':' + msg.messageId;
    await this.db.put(key, JSON.stringify(msg));
  }

  /**
   * Get message history for a conversation, most recent last.
   */
  async getConversationHistory(conversationId: string, limit: number = 50): Promise<StoredMessage[]> {
    const prefix = NS.HISTORY + conversationId + ':';
    const messages: StoredMessage[] = [];

    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF', reverse: true, limit })) {
      messages.push(JSON.parse(value));
    }
    return messages.reverse(); // oldest first
  }

  /**
   * Update a message's delivery status.
   */
  async updateMessageStatus(conversationId: string, messageId: string, status: StoredMessage['status']): Promise<void> {
    const prefix = NS.HISTORY + conversationId + ':';
    for await (const [key, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      const msg: StoredMessage = JSON.parse(value);
      if (msg.messageId === messageId) {
        msg.status = status;
        await this.db.put(key, JSON.stringify(msg));
        break;
      }
    }
  }

  /**
   * Get all conversation IDs with their last message.
   */
  async getConversations(): Promise<{ conversationId: string; lastMessage: StoredMessage }[]> {
    const convos = new Map<string, StoredMessage>();

    for await (const [, value] of this.db.iterator({ gte: NS.HISTORY, lt: NS.HISTORY + '\xFF' })) {
      const msg: StoredMessage = JSON.parse(value);
      const existing = convos.get(msg.conversationId);
      if (!existing || msg.timestamp > existing.timestamp) {
        convos.set(msg.conversationId, msg);
      }
    }

    return Array.from(convos.entries())
      .map(([conversationId, lastMessage]) => ({ conversationId, lastMessage }))
      .sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
  }

  // ─── Peer ID Mapping (libp2p <-> DecentraNet) ──────────────────────────

  /**
   * Store a mapping between libp2p PeerId and DecentraNet PeerId.
   */
  async storePeerIdMapping(libp2pId: string, decentraId: string): Promise<void> {
    await this.db.put(NS.IDMAP + 'l2d:' + libp2pId, decentraId);
    await this.db.put(NS.IDMAP + 'd2l:' + decentraId, libp2pId);
  }

  /**
   * Look up a DecentraNet PeerId from a libp2p PeerId.
   */
  async getDecentraId(libp2pId: string): Promise<string | null> {
    try {
      return await this.db.get(NS.IDMAP + 'l2d:' + libp2pId);
    } catch {
      return null;
    }
  }

  /**
   * Look up a libp2p PeerId from a DecentraNet PeerId.
   */
  async getLibp2pId(decentraId: string): Promise<string | null> {
    try {
      return await this.db.get(NS.IDMAP + 'd2l:' + decentraId);
    } catch {
      return null;
    }
  }

  // ─── Group Storage ──────────────────────────────────────────────────────

  async storeGroup(group: any): Promise<void> {
    await this.db.put(NS.GROUP + group.groupId, JSON.stringify(group));
  }

  async getGroup(groupId: string): Promise<any | null> {
    try {
      return JSON.parse(await this.db.get(NS.GROUP + groupId));
    } catch {
      return null;
    }
  }

  async getAllGroups(): Promise<any[]> {
    const groups: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.GROUP, lt: NS.GROUP + '\xFF' })) {
      groups.push(JSON.parse(value));
    }
    return groups;
  }

  // ─── Content Manifest Storage ──────────────────────────────────────────

  async storeManifest(manifest: ContentManifest): Promise<void> {
    const key = NS.MANIFEST + manifest.contentId;
    const serializable = {
      ...manifest,
      shardLocations: Object.fromEntries(manifest.shardLocations),
      encryptionNonce: Buffer.from(manifest.encryptionNonce).toString('base64'),
      signature: Buffer.from(manifest.signature).toString('base64'),
    };
    await this.db.put(key, JSON.stringify(serializable));
  }

  async getManifest(contentId: string): Promise<ContentManifest | null> {
    try {
      const value = await this.db.get(NS.MANIFEST + contentId);
      const parsed = JSON.parse(value);
      return {
        ...parsed,
        shardLocations: new Map(Object.entries(parsed.shardLocations)),
        encryptionNonce: new Uint8Array(Buffer.from(parsed.encryptionNonce, 'base64')),
        signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
      };
    } catch {
      return null;
    }
  }

  // ─── Account Bundle Storage ─────────────────────────────────────────

  /** Build an account bundle from current stored data */
  async buildAccountBundle(peerId: PeerId, signFn: (data: Uint8Array) => Uint8Array): Promise<AccountBundle> {
    const contacts: PeerId[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.PEER, lt: NS.PEER + '\xFF' })) {
      const parsed = JSON.parse(value);
      if (parsed.peerId !== peerId) contacts.push(parsed.peerId);
    }

    const groups: AccountBundle['groups'] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.GROUP, lt: NS.GROUP + '\xFF' })) {
      const g = JSON.parse(value);
      groups.push({
        groupId: g.groupId,
        name: g.name,
        groupKey: g.groupKey,
        members: g.members,
      });
    }

    let displayName: string | undefined;
    try {
      displayName = (await this.db.get(NS.META + 'displayName')) || undefined;
    } catch {}

    const bundle: AccountBundle = {
      version: 1,
      peerId,
      contacts,
      groups,
      settings: { displayName },
      updatedAt: Date.now(),
      signature: new Uint8Array(0),
    };

    // Sign the bundle
    const dataToSign = new TextEncoder().encode(JSON.stringify({
      ...bundle,
      signature: undefined,
    }));
    bundle.signature = signFn(dataToSign);

    return bundle;
  }

  /** Restore contacts, groups, settings from a bundle */
  async restoreFromBundle(bundle: AccountBundle): Promise<void> {
    // Restore settings
    if (bundle.settings.displayName) {
      await this.db.put(NS.META + 'displayName', bundle.settings.displayName);
    }

    // Restore groups
    for (const group of bundle.groups) {
      await this.storeGroup({
        ...group,
        creatorId: bundle.peerId,
        createdAt: bundle.updatedAt,
        lastMessageAt: bundle.updatedAt,
      });
    }

    console.log(`[Store] Restored ${bundle.contacts.length} contacts, ${bundle.groups.length} groups from bundle`);
  }

  /** Store an encrypted account bundle for a peer (opaque storage) */
  async storeBundle(peerId: PeerId, encryptedBundle: string): Promise<void> {
    await this.db.put(NS.BUNDLE + peerId, encryptedBundle);
  }

  /** Retrieve an encrypted account bundle for a peer */
  async getBundle(peerId: PeerId): Promise<string | null> {
    try {
      return await this.db.get(NS.BUNDLE + peerId);
    } catch {
      return null;
    }
  }

  // ─── TOFU (Trust On First Use) ────────────────────────────────────────

  /** Store a pinned key for a peer (first-seen trust) */
  async storePinnedKey(pin: PinnedKey): Promise<void> {
    await this.db.put(NS.TOFU + pin.peerId, JSON.stringify(pin));
  }

  /** Get the pinned key for a peer */
  async getPinnedKey(peerId: PeerId): Promise<PinnedKey | null> {
    try {
      return JSON.parse(await this.db.get(NS.TOFU + peerId));
    } catch {
      return null;
    }
  }

  /** Update the lastVerified timestamp for a pinned key */
  async updatePinnedKeyVerified(peerId: PeerId): Promise<void> {
    const pin = await this.getPinnedKey(peerId);
    if (pin) {
      pin.lastVerified = Date.now();
      await this.storePinnedKey(pin);
    }
  }

  // ─── Settings (META namespace) ──────────────────────────────────────────

  async getMeta(key: string): Promise<string | null> {
    try {
      return await this.db.get(NS.META + key);
    } catch {
      return null;
    }
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.put(NS.META + key, value);
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  getStorageUsage(): { used: number; max: number; percentage: number } {
    return {
      used: this.currentStorageBytes,
      max: this.maxStorageBytes,
      percentage: (this.currentStorageBytes / this.maxStorageBytes) * 100,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private async calculateStorageUsage(): Promise<void> {
    let total = 0;
    for await (const [, value] of this.db.iterator({ gte: NS.SHARD, lt: NS.SHARD + '\xFF' })) {
      const parsed = JSON.parse(value);
      total += parsed.size || 0;
    }
    this.currentStorageBytes = total;
  }
}

// ─── Envelope Serialization Helpers ──────────────────────────────────────────

function serializeEnvelope(envelope: MessageEnvelope): Record<string, unknown> {
  return {
    ...envelope,
    encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
    nonce: Buffer.from(envelope.nonce).toString('base64'),
    ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
    authTag: Buffer.from(envelope.authTag).toString('base64'),
    signature: Buffer.from(envelope.signature).toString('base64'),
  };
}

function deserializeEnvelope(parsed: any): MessageEnvelope {
  return {
    ...parsed,
    encryptedPayload: new Uint8Array(Buffer.from(parsed.encryptedPayload, 'base64')),
    nonce: new Uint8Array(Buffer.from(parsed.nonce, 'base64')),
    ephemeralPublicKey: new Uint8Array(Buffer.from(parsed.ephemeralPublicKey, 'base64')),
    authTag: new Uint8Array(Buffer.from(parsed.authTag, 'base64')),
    signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
