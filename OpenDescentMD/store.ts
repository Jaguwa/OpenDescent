/**
 * Local Storage Engine — LevelDB-backed key-value store
 *
 * Each peer maintains local storage for:
 * - Shards they're hosting for the network
 * - Their own messages (sent and received)
 * - Known peer profiles
 * - Pending outbound messages (store-and-forward queue)
 *
 * This is the LOCAL storage — distinct from the distributed storage
 * which spans the whole network. Think of this as each peer's
 * "hard drive" in the distributed filesystem.
 */

import { Level } from 'level';
import * as path from 'path';
import * as fs from 'fs';
import type { Shard, MessageEnvelope, PeerProfile, ContentManifest, PeerId } from '../types/index.js';

// Namespace prefixes for LevelDB keys
const NS = {
  SHARD: 'shard:',
  MESSAGE: 'msg:',
  PENDING: 'pending:',
  PEER: 'peer:',
  MANIFEST: 'manifest:',
  META: 'meta:',
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

    this.db = new Level(path.join(dataDir, 'store'), {
      valueEncoding: 'utf8',
    });
  }

  async open(): Promise<void> {
    await this.db.open();
    await this.calculateStorageUsage();
    console.log(`[Store] Opened. Current usage: ${this.formatBytes(this.currentStorageBytes)} / ${this.formatBytes(this.maxStorageBytes)}`);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // ─── Shard Storage ─────────────────────────────────────────────────────

  /**
   * Store a shard (encrypted data chunk from the network).
   * Returns false if we're at capacity.
   */
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

    console.log(`[Store] Stored shard ${shard.shardId} (${this.formatBytes(shard.size)})`);
    return true;
  }

  /**
   * Retrieve a shard by ID.
   */
  async getShard(shardId: string): Promise<Shard | null> {
    try {
      const key = NS.SHARD + shardId;
      const value = await this.db.get(key);
      const parsed = JSON.parse(value);
      return {
        ...parsed,
        data: new Uint8Array(Buffer.from(parsed.data, 'base64')),
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if we have a specific shard.
   */
  async hasShard(shardId: string): Promise<boolean> {
    try {
      await this.db.get(NS.SHARD + shardId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a shard (e.g., when content expires or is deleted).
   */
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

  /**
   * List all shard IDs we're holding.
   */
  async listShardIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const key of this.db.keys({ gte: NS.SHARD, lt: NS.SHARD + '\xFF' })) {
      ids.push(key.slice(NS.SHARD.length));
    }
    return ids;
  }

  // ─── Message Storage ───────────────────────────────────────────────────

  /**
   * Store a received/sent message envelope.
   */
  async storeMessage(envelope: MessageEnvelope): Promise<void> {
    const key = NS.MESSAGE + envelope.messageId;
    const value = JSON.stringify({
      ...envelope,
      encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
      nonce: Buffer.from(envelope.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
      signature: Buffer.from(envelope.signature).toString('base64'),
    });

    await this.db.put(key, value);
  }

  /**
   * Get a message by ID.
   */
  async getMessage(messageId: string): Promise<MessageEnvelope | null> {
    try {
      const value = await this.db.get(NS.MESSAGE + messageId);
      const parsed = JSON.parse(value);
      return {
        ...parsed,
        encryptedPayload: new Uint8Array(Buffer.from(parsed.encryptedPayload, 'base64')),
        nonce: new Uint8Array(Buffer.from(parsed.nonce, 'base64')),
        ephemeralPublicKey: new Uint8Array(Buffer.from(parsed.ephemeralPublicKey, 'base64')),
        signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
      };
    } catch {
      return null;
    }
  }

  // ─── Pending Message Queue (Store-and-Forward) ─────────────────────────

  /**
   * Queue a message for delivery to an offline peer.
   * Other peers hold these until the recipient comes online.
   */
  async queuePendingMessage(recipientId: PeerId, envelope: MessageEnvelope): Promise<void> {
    const key = NS.PENDING + recipientId + ':' + envelope.messageId;
    const value = JSON.stringify({
      ...envelope,
      encryptedPayload: Buffer.from(envelope.encryptedPayload).toString('base64'),
      nonce: Buffer.from(envelope.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(envelope.ephemeralPublicKey).toString('base64'),
      signature: Buffer.from(envelope.signature).toString('base64'),
      queuedAt: Date.now(),
    });

    await this.db.put(key, value);
    console.log(`[Store] Queued message ${envelope.messageId} for ${recipientId}`);
  }

  /**
   * Get all pending messages for a specific peer.
   * Called when that peer comes online.
   */
  async getPendingMessages(recipientId: PeerId): Promise<MessageEnvelope[]> {
    const prefix = NS.PENDING + recipientId + ':';
    const messages: MessageEnvelope[] = [];

    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      const parsed = JSON.parse(value);
      messages.push({
        ...parsed,
        encryptedPayload: new Uint8Array(Buffer.from(parsed.encryptedPayload, 'base64')),
        nonce: new Uint8Array(Buffer.from(parsed.nonce, 'base64')),
        ephemeralPublicKey: new Uint8Array(Buffer.from(parsed.ephemeralPublicKey, 'base64')),
        signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
      });
    }

    return messages;
  }

  /**
   * Remove a pending message after successful delivery.
   */
  async removePendingMessage(recipientId: PeerId, messageId: string): Promise<void> {
    await this.db.del(NS.PENDING + recipientId + ':' + messageId);
  }

  /**
   * Clean up expired pending messages.
   */
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

    if (cleaned > 0) {
      console.log(`[Store] Cleaned ${cleaned} expired pending messages`);
    }
    return cleaned;
  }

  // ─── Peer Profile Storage ─────────────────────────────────────────────

  /**
   * Store/update a known peer's profile.
   */
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

  /**
   * Get a peer's profile by their ID.
   */
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

  /**
   * Get all known peer profiles.
   */
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

  // ─── Content Manifest Storage ──────────────────────────────────────────

  /**
   * Store a content manifest (describes how content is sharded and distributed).
   */
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

  /**
   * Get a content manifest by content ID.
   */
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

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
}
