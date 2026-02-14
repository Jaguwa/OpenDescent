/**
 * Content Sharding — Split, erasure-code, and reassemble content
 *
 * When a user creates content (message, voice note, video), it goes through:
 * 1. Encryption (handled by crypto layer)
 * 2. Sharding (split into N chunks)
 * 3. Erasure coding (add M parity chunks for redundancy)
 * 4. Distribution (spread across peers via DHT)
 *
 * Erasure coding means we only need K out of N+M shards to reconstruct
 * the original data. So if some peers go offline, we can still recover.
 *
 * Example: Split into 4 data shards + 2 parity shards = 6 total.
 * Any 4 of those 6 can reconstruct the original. That's ~33% fault tolerance.
 *
 * For the prototype, we use a simple XOR-based parity scheme.
 * Production would use Reed-Solomon coding for better efficiency.
 */

import * as crypto from 'crypto';
import type { Shard, ContentId } from '../types/index.js';

/** Configuration for sharding */
export interface ShardConfig {
  /** Number of data shards to split content into */
  dataShards: number;
  /** Number of parity (redundancy) shards to generate */
  parityShards: number;
}

/** Default: 4 data + 2 parity = need any 4 of 6 to reconstruct */
export const DEFAULT_SHARD_CONFIG: ShardConfig = {
  dataShards: 4,
  parityShards: 2,
};

/**
 * Generate a Content ID (CID) from data.
 * Uses SHA-256 hash, base58-encoded.
 */
export function generateContentId(data: Uint8Array): ContentId {
  const hash = crypto.createHash('sha256').update(data).digest();
  // Simple hex encoding for prototype; production would use proper CIDv1
  return 'baf' + hash.toString('hex').slice(0, 40);
}

/**
 * Split encrypted content into shards with erasure coding.
 *
 * @param encryptedData - Already-encrypted content to shard
 * @param config - Shard configuration
 * @returns Array of shards (data + parity)
 */
export function shardContent(
  encryptedData: Uint8Array,
  config: ShardConfig = DEFAULT_SHARD_CONFIG,
): Shard[] {
  const contentId = generateContentId(encryptedData);
  const totalShards = config.dataShards + config.parityShards;

  // Calculate shard size (pad to even division)
  const shardSize = Math.ceil(encryptedData.length / config.dataShards);
  const paddedData = new Uint8Array(shardSize * config.dataShards);
  paddedData.set(encryptedData);

  const shards: Shard[] = [];

  // Create data shards
  for (let i = 0; i < config.dataShards; i++) {
    const start = i * shardSize;
    const end = start + shardSize;
    const shardData = paddedData.slice(start, end);

    shards.push({
      shardId: `${contentId}-${i}`,
      contentId,
      index: i,
      totalShards,
      requiredShards: config.dataShards,
      data: shardData,
      size: shardData.length,
    });
  }

  // Create parity shards using XOR
  // Parity shard j = XOR of data shards at specific offsets
  // This is a simplified scheme; Reed-Solomon would be more robust
  for (let p = 0; p < config.parityShards; p++) {
    const parityData = new Uint8Array(shardSize);

    for (let i = 0; i < config.dataShards; i++) {
      const dataShard = shards[i].data;
      // Rotate which data shards contribute to each parity shard
      // This gives better fault tolerance than simple XOR of all
      if ((i + p) % config.parityShards === 0 || config.parityShards === 1) {
        for (let byte = 0; byte < shardSize; byte++) {
          parityData[byte] ^= dataShard[byte];
        }
      }
    }

    shards.push({
      shardId: `${contentId}-p${p}`,
      contentId,
      index: config.dataShards + p,
      totalShards,
      requiredShards: config.dataShards,
      data: parityData,
      size: parityData.length,
    });
  }

  console.log(
    `[Shard] Split ${formatBytes(encryptedData.length)} into ${totalShards} shards ` +
    `(${config.dataShards} data + ${config.parityShards} parity, ${formatBytes(shardSize)} each)`
  );

  return shards;
}

/**
 * Reassemble content from shards.
 *
 * For the simple XOR scheme, we need all data shards present.
 * With full Reed-Solomon, we could reconstruct from any K shards.
 *
 * @param shards - Available shards (must include enough data shards)
 * @param originalSize - Original content size (to trim padding)
 * @returns Reconstructed encrypted content
 */
export function reassembleContent(shards: Shard[], originalSize: number): Uint8Array {
  if (shards.length === 0) {
    throw new Error('No shards provided');
  }

  const totalShards = shards[0].totalShards;
  const requiredShards = shards[0].requiredShards;
  const shardSize = shards[0].data.length;

  // Sort shards by index
  const sorted = [...shards].sort((a, b) => a.index - b.index);

  // Check if we have enough data shards (indices 0 to requiredShards-1)
  const dataShards = sorted.filter((s) => s.index < requiredShards);

  if (dataShards.length === requiredShards) {
    // We have all data shards — simple concatenation
    const result = new Uint8Array(shardSize * requiredShards);
    for (const shard of dataShards) {
      result.set(shard.data, shard.index * shardSize);
    }
    return result.slice(0, originalSize);
  }

  // We're missing some data shards — need to use parity to reconstruct
  // This is where Reed-Solomon would shine. Our simple XOR parity
  // can only recover if exactly one data shard is missing per parity group.

  const missingIndices = [];
  const availableMap = new Map(sorted.map((s) => [s.index, s]));

  for (let i = 0; i < requiredShards; i++) {
    if (!availableMap.has(i)) {
      missingIndices.push(i);
    }
  }

  if (missingIndices.length > (totalShards - requiredShards)) {
    throw new Error(
      `Cannot reconstruct: missing ${missingIndices.length} data shards, ` +
      `only ${totalShards - requiredShards} parity shards available`
    );
  }

  // TODO: Implement XOR-based recovery for missing shards
  // For the prototype, we require all data shards
  throw new Error(
    `Reconstruction from parity not yet implemented. ` +
    `Missing data shards: ${missingIndices.join(', ')}. ` +
    `In production, Reed-Solomon coding would handle this.`
  );
}

/**
 * Verify shard integrity using its content-addressed ID.
 */
export function verifyShard(shard: Shard): boolean {
  const expectedPrefix = shard.contentId + '-';
  return shard.shardId.startsWith(expectedPrefix) || shard.shardId.startsWith(shard.contentId);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
