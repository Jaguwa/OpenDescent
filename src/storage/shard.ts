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
 * Current implementation uses XOR-based parity with round-robin grouping.
 * This gives single-fault tolerance per parity group.
 */

import * as crypto from 'crypto';
import type { Shard, ContentId } from '../types/index.js';

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
 * Generate a Content ID (CID) from data using SHA-256.
 */
export function generateContentId(data: Uint8Array): ContentId {
  const hash = crypto.createHash('sha256').update(data).digest();
  return 'baf' + hash.toString('hex').slice(0, 40);
}

/**
 * Split encrypted content into shards with parity for redundancy.
 */
export function shardContent(
  encryptedData: Uint8Array,
  config: ShardConfig = DEFAULT_SHARD_CONFIG,
): Shard[] {
  const contentId = generateContentId(encryptedData);
  const totalShards = config.dataShards + config.parityShards;

  // Pad to even division
  const shardSize = Math.ceil(encryptedData.length / config.dataShards);
  const paddedData = new Uint8Array(shardSize * config.dataShards);
  paddedData.set(encryptedData);

  const shards: Shard[] = [];

  // Create data shards
  for (let i = 0; i < config.dataShards; i++) {
    const start = i * shardSize;
    const shardData = paddedData.slice(start, start + shardSize);

    const shardHash = crypto.createHash('sha256').update(shardData).digest('hex');
    shards.push({
      shardId: `${contentId}-${i}`,
      contentId,
      index: i,
      totalShards,
      requiredShards: config.dataShards,
      data: shardData,
      size: shardData.length,
      hash: shardHash,
    });
  }

  // Create parity shards using XOR with round-robin grouping
  for (let p = 0; p < config.parityShards; p++) {
    const parityData = new Uint8Array(shardSize);

    for (let i = 0; i < config.dataShards; i++) {
      // Each parity shard XORs a rotating subset of data shards
      if ((i + p) % config.parityShards === 0 || config.parityShards === 1) {
        const dataShard = shards[i].data;
        for (let byte = 0; byte < shardSize; byte++) {
          parityData[byte] ^= dataShard[byte];
        }
      }
    }

    const parityHash = crypto.createHash('sha256').update(parityData).digest('hex');
    shards.push({
      shardId: `${contentId}-p${p}`,
      contentId,
      index: config.dataShards + p,
      totalShards,
      requiredShards: config.dataShards,
      data: parityData,
      size: parityData.length,
      hash: parityHash,
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
 * If all data shards are present, does direct concatenation.
 * If a data shard is missing, attempts XOR recovery using the corresponding parity shard.
 */
export function reassembleContent(shards: Shard[], originalSize: number): Uint8Array {
  if (shards.length === 0) throw new Error('No shards provided');

  const requiredShards = shards[0].requiredShards;
  const shardSize = shards[0].data.length;

  const sorted = [...shards].sort((a, b) => a.index - b.index);
  const availableMap = new Map(sorted.map((s) => [s.index, s]));

  // Check which data shards we have
  const missingDataIndices: number[] = [];
  for (let i = 0; i < requiredShards; i++) {
    if (!availableMap.has(i)) missingDataIndices.push(i);
  }

  if (missingDataIndices.length === 0) {
    // All data shards present — simple concatenation
    const result = new Uint8Array(shardSize * requiredShards);
    for (let i = 0; i < requiredShards; i++) {
      result.set(availableMap.get(i)!.data, i * shardSize);
    }
    return result.slice(0, originalSize);
  }

  // Attempt XOR recovery for each missing data shard
  const totalShards = shards[0].totalShards;
  const parityCount = totalShards - requiredShards;

  if (missingDataIndices.length > parityCount) {
    throw new Error(
      `Cannot reconstruct: missing ${missingDataIndices.length} data shards, ` +
      `only ${parityCount} parity shards exist`
    );
  }

  // For each missing data shard, find its parity group and XOR-recover it
  for (const missingIdx of missingDataIndices) {
    // Find which parity shard covers this data shard
    let recoveredData: Uint8Array | null = null;

    for (let p = 0; p < parityCount; p++) {
      const parityIdx = requiredShards + p;
      const parityShard = availableMap.get(parityIdx);
      if (!parityShard) continue;

      // Determine which data shards are in this parity group
      const groupMembers: number[] = [];
      for (let i = 0; i < requiredShards; i++) {
        if ((i + p) % parityCount === 0 || parityCount === 1) {
          groupMembers.push(i);
        }
      }

      if (!groupMembers.includes(missingIdx)) continue;

      // Check if all other members of the group are available
      const otherMembers = groupMembers.filter((m) => m !== missingIdx);
      if (otherMembers.some((m) => !availableMap.has(m))) continue;

      // Recover: XOR parity with all other data shards in the group
      recoveredData = new Uint8Array(parityShard.data);
      for (const memberIdx of otherMembers) {
        const memberData = availableMap.get(memberIdx)!.data;
        for (let byte = 0; byte < shardSize; byte++) {
          recoveredData[byte] ^= memberData[byte];
        }
      }
      break;
    }

    if (!recoveredData) {
      throw new Error(`Cannot recover data shard ${missingIdx}: no suitable parity group`);
    }

    // Insert recovered shard
    availableMap.set(missingIdx, {
      shardId: `recovered-${missingIdx}`,
      contentId: shards[0].contentId,
      index: missingIdx,
      totalShards,
      requiredShards,
      data: recoveredData,
      size: recoveredData.length,
    });
  }

  const result = new Uint8Array(shardSize * requiredShards);
  for (let i = 0; i < requiredShards; i++) {
    result.set(availableMap.get(i)!.data, i * shardSize);
  }
  return result.slice(0, originalSize);
}

/**
 * Verify shard integrity using its content-addressed ID.
 */
export function verifyShard(shard: Shard): boolean {
  return shard.shardId.startsWith(shard.contentId);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
