/**
 * Content Sharing — Encrypt, shard, distribute, and retrieve files
 *
 * File sharing flow:
 * 1. Sender reads file, encrypts with a random AES-256 key
 * 2. Encrypted data is split into shards (4 data + 2 parity)
 * 3. Shards are distributed across connected peers via SHARD_STORE protocol
 * 4. A manifest (content ID, shard locations, encryption key) is sent to
 *    recipients as an E2E encrypted message through the messaging layer
 *
 * Retrieval flow:
 * 1. Recipient receives manifest via messaging
 * 2. Requests shards from listed peers via SHARD_RETRIEVE protocol
 * 3. Reassembles shards and decrypts with the included key
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PeerId, ContentManifest, Shard, ContentType } from '../types/index.js';
import { shardContent, reassembleContent, DEFAULT_SHARD_CONFIG } from '../storage/shard.js';
import { DecentraNode, PROTOCOLS } from '../network/node.js';
import { LocalStore } from '../storage/store.js';

/** Info about a shared file, sent as a message body */
export interface SharedFileInfo {
  contentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** AES-256 key used to encrypt the file (base64) */
  encryptionKey: string;
  /** AES-GCM nonce used for file encryption (base64) */
  encryptionNonce: string;
  /** Map of shard index -> peer IDs holding that shard */
  shardLocations: Record<number, string[]>;
  shardCount: number;
  requiredShards: number;
  originalSize: number;
}

export class ContentManager {
  private node: DecentraNode;
  private store: LocalStore;

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;

    // Handle shard store requests from other peers
    this.node.on('shard:stored', async (event) => {
      if (event.data instanceof Uint8Array) {
        await this.handleShardStore(event.data);
      }
    });

    // Handle shard retrieve requests from other peers
    this.node.on('shard:requested', async (event) => {
      // This is handled directly in node.ts protocol handler now
    });
  }

  /**
   * Share a file with one or more recipients.
   * Returns the SharedFileInfo to be sent as a message.
   */
  async shareFile(filePath: string): Promise<SharedFileInfo> {
    // Read file
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    const fileData = new Uint8Array(fs.readFileSync(absolutePath));
    const fileName = path.basename(absolutePath);
    const fileSize = fileData.length;
    const mimeType = guessMimeType(fileName);

    console.log(`[Content] Preparing "${fileName}" (${formatBytes(fileSize)})`);

    // Encrypt with random AES-256 key
    const encryptionKey = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(fileData)),
      cipher.final(),
      cipher.getAuthTag(), // append auth tag to encrypted data
    ]);
    const encryptedData = new Uint8Array(encrypted);

    // Shard the encrypted data
    const shards = shardContent(encryptedData);
    const contentId = shards[0].contentId;

    // Store shards locally
    for (const shard of shards) {
      await this.store.storeShard(shard);
    }

    // Distribute shards to connected peers
    const shardLocations = await this.distributeShards(shards);

    // Add ourselves to all shard locations (we have all shards)
    const myId = this.node.getPeerId();
    for (let i = 0; i < shards.length; i++) {
      if (!shardLocations[i]) shardLocations[i] = [];
      if (!shardLocations[i].includes(myId)) {
        shardLocations[i].push(myId);
      }
    }

    const fileInfo: SharedFileInfo = {
      contentId,
      fileName,
      fileSize,
      mimeType,
      encryptionKey: Buffer.from(encryptionKey).toString('base64'),
      encryptionNonce: Buffer.from(nonce).toString('base64'),
      shardLocations,
      shardCount: shards.length,
      requiredShards: shards[0].requiredShards,
      originalSize: encryptedData.length,
    };

    // Store manifest locally
    const manifest: ContentManifest = {
      contentId,
      author: myId,
      type: 'file' as ContentType,
      totalSize: fileSize,
      shardCount: shards.length,
      requiredShards: shards[0].requiredShards,
      shardLocations: new Map(Object.entries(shardLocations).map(
        ([k, v]) => [parseInt(k), v]
      )),
      encryptionNonce: nonce,
      recipients: [],
      createdAt: Date.now(),
      signature: new Uint8Array(0), // TODO: sign manifest
    };
    await this.store.storeManifest(manifest);

    console.log(`[Content] "${fileName}" ready: ${contentId.slice(0, 12)}... (${shards.length} shards distributed)`);
    return fileInfo;
  }

  /**
   * Download and reconstruct a shared file.
   */
  async downloadFile(fileInfo: SharedFileInfo, outputDir: string): Promise<string> {
    console.log(`[Content] Downloading "${fileInfo.fileName}" (${formatBytes(fileInfo.fileSize)})`);

    const shards: Shard[] = [];
    const neededShards = fileInfo.requiredShards;

    // Try to collect enough shards
    for (let i = 0; i < fileInfo.shardCount && shards.length < neededShards; i++) {
      const shardId = `${fileInfo.contentId}-${i < fileInfo.requiredShards ? i : 'p' + (i - fileInfo.requiredShards)}`;
      const holders = fileInfo.shardLocations[i] || [];

      // Try local first
      const localShard = await this.store.getShard(shardId);
      if (localShard) {
        shards.push(localShard);
        continue;
      }

      // Request from remote peers
      let retrieved = false;
      for (const peerId of holders) {
        if (peerId === this.node.getPeerId()) continue;
        const shard = await this.requestShard(peerId, shardId);
        if (shard) {
          shards.push(shard);
          await this.store.storeShard(shard); // cache locally
          retrieved = true;
          break;
        }
      }

      if (!retrieved) {
        console.log(`[Content] Could not retrieve shard ${i} from any peer`);
      }
    }

    if (shards.length < neededShards) {
      throw new Error(
        `Not enough shards: got ${shards.length}, need ${neededShards}. ` +
        `Some peers may be offline.`
      );
    }

    // Reassemble
    const encryptedData = reassembleContent(shards, fileInfo.originalSize);

    // Decrypt (auth tag is appended to encrypted data)
    const key = Buffer.from(fileInfo.encryptionKey, 'base64');
    const nonce = Buffer.from(fileInfo.encryptionNonce, 'base64');
    const authTag = encryptedData.slice(encryptedData.length - 16);
    const ciphertext = encryptedData.slice(0, encryptedData.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(Buffer.from(authTag));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]);

    // Write to output
    const outputPath = path.join(outputDir, fileInfo.fileName);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, decrypted);

    console.log(`[Content] Saved "${fileInfo.fileName}" to ${outputPath}`);
    return outputPath;
  }

  /**
   * Distribute shards across connected peers.
   * Returns a map of shard index -> peer IDs that accepted the shard.
   */
  private async distributeShards(shards: Shard[]): Promise<Record<number, string[]>> {
    const connectedPeers = this.node.getConnectedPeers()
      .filter((p) => p.decentraId);
    const locations: Record<number, string[]> = {};

    if (connectedPeers.length === 0) {
      console.log(`[Content] No connected peers — shards stored locally only`);
      return locations;
    }

    for (let i = 0; i < shards.length; i++) {
      locations[i] = [];
      // Send each shard to 2 peers (round-robin) for redundancy
      for (let r = 0; r < Math.min(2, connectedPeers.length); r++) {
        const peerIdx = (i + r) % connectedPeers.length;
        const peer = connectedPeers[peerIdx];
        if (!peer.decentraId) continue;

        const stored = await this.sendShardToPeer(peer.decentraId, shards[i]);
        if (stored) {
          locations[i].push(peer.decentraId);
        }
      }
    }

    const totalDistributed = Object.values(locations).reduce((sum, l) => sum + l.length, 0);
    console.log(`[Content] Distributed ${totalDistributed} shard copies across ${connectedPeers.length} peer(s)`);
    return locations;
  }

  private async sendShardToPeer(peerId: PeerId, shard: Shard): Promise<boolean> {
    const payload = JSON.stringify({
      shardId: shard.shardId,
      contentId: shard.contentId,
      index: shard.index,
      totalShards: shard.totalShards,
      requiredShards: shard.requiredShards,
      data: Buffer.from(shard.data).toString('base64'),
      size: shard.size,
    });

    const data = new TextEncoder().encode(payload);
    const response = await this.node.sendToPeer(peerId, PROTOCOLS.SHARD_STORE, data);

    if (response) {
      const result = new TextDecoder().decode(response);
      return result === 'STORED';
    }
    return false;
  }

  private async requestShard(peerId: PeerId, shardId: string): Promise<Shard | null> {
    const data = new TextEncoder().encode(shardId);
    const response = await this.node.sendToPeer(peerId, PROTOCOLS.SHARD_RETRIEVE, data);

    if (!response) return null;

    const text = new TextDecoder().decode(response);
    if (text === 'SHARD_NOT_FOUND') return null;

    try {
      const parsed = JSON.parse(text);
      return {
        shardId: parsed.shardId,
        contentId: parsed.contentId,
        index: parsed.index,
        totalShards: parsed.totalShards,
        requiredShards: parsed.requiredShards,
        data: new Uint8Array(Buffer.from(parsed.data, 'base64')),
        size: parsed.size,
      };
    } catch {
      return null;
    }
  }

  private async handleShardStore(data: Uint8Array): Promise<void> {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data));
      const shard: Shard = {
        shardId: parsed.shardId,
        contentId: parsed.contentId,
        index: parsed.index,
        totalShards: parsed.totalShards,
        requiredShards: parsed.requiredShards,
        data: new Uint8Array(Buffer.from(parsed.data, 'base64')),
        size: parsed.size,
      };

      const stored = await this.store.storeShard(shard);
      if (stored) {
        console.log(`[Content] Stored shard ${shard.shardId} (${formatBytes(shard.size)})`);
      }
    } catch (error) {
      console.error(`[Content] Failed to store incoming shard:`, error);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.txt': 'text/plain', '.json': 'application/json',
  };
  return types[ext] || 'application/octet-stream';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
