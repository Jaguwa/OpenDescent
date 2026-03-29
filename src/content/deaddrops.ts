/**
 * Dead Drops — Anonymous, onion-routed posts for DecentraNet
 *
 * Zero attribution: no authorId, no signature, no metadata.
 * Posts are submitted through a 3-hop onion circuit so even network
 * observers can't trace authorship. Content is encrypted with a
 * daily-rotating network-wide key. Proof-of-work prevents spam.
 */

import * as crypto from 'crypto';
import { encryptForPeer, decryptFromPeer, encryptWithGroupKey, decryptWithGroupKey } from '../crypto/encryption.js';
import type { DecentraNode } from '../network/node.js';
import { PROTOCOLS } from '../network/node.js';
import type { LocalStore } from '../storage/store.js';
import type { DeadDrop, DeadDropVote, OnionLayer } from '../types/index.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DROP_EXPIRY_MS = 24 * 60 * 60 * 1000;   // 24 hours
const POW_DIFFICULTY_BASE = 18;                 // baseline: 18 leading zero bits (~262K hashes avg)
const RELAY_HOP_COUNT = 3;                      // 3-hop onion circuit
const RELAY_MIN_DELAY_MS = 2000;                // 2-15 second random delay per relay
const RELAY_MAX_DELAY_MS = 15000;
const MAX_DROP_LENGTH = 1000;                   // character limit
const NETWORK_KEY_CONTEXT = 'decentranet-deaddrops-v1';
const SEEN_MAX = 5000;
const SEEN_PRUNE_INTERVAL = 10 * 60 * 1000;    // 10 minutes

// ─── Service ────────────────────────────────────────────────────────────────

export class DeadDropService {
  private node: DecentraNode;
  private store: LocalStore;
  private seenDropIds: Map<string, number> = new Map();
  private seenVoteIds: Map<string, number> = new Map();
  public onNewDrop: Array<(drop: DeadDrop, content: string) => void> = [];
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;

    // Prune seen IDs periodically
    this.pruneTimer = setInterval(() => {
      const cutoff = Date.now() - DROP_EXPIRY_MS;
      for (const [id, ts] of this.seenDropIds) {
        if (ts < cutoff) this.seenDropIds.delete(id);
      }
      if (this.seenDropIds.size > SEEN_MAX) {
        // Remove oldest entries
        const sorted = [...this.seenDropIds.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < sorted.length - SEEN_MAX; i++) {
          this.seenDropIds.delete(sorted[i][0]);
        }
      }
      for (const [id, ts] of this.seenVoteIds) {
        if (ts < cutoff) this.seenVoteIds.delete(id);
      }
    }, SEEN_PRUNE_INTERVAL);
  }

  // ─── Adaptive Difficulty ─────────────────────────────────────────────────

  private async getDropCountLastHour(): Promise<number> {
    const cutoff = Date.now() - 3600000;
    let count = 0;
    for await (const [key] of this.store['db'].iterator({ gte: 'ddropidx:', lt: 'ddropidx:\xFF', reverse: true })) {
      // Key format: ddropidx:{paddedTimestamp}:{dropId}
      const parts = key.split(':');
      if (parts.length >= 2) {
        const ts = parseInt(parts[1], 10);
        if (ts < cutoff) break;
        count++;
      }
    }
    return count;
  }

  async getAdaptiveDifficulty(): Promise<number> {
    const count = await this.getDropCountLastHour();
    if (count > 500) return 24;  // ~12s
    if (count > 200) return 22;  // ~3s
    if (count > 50) return 20;   // ~800ms
    return POW_DIFFICULTY_BASE;   // ~200ms
  }

  // ─── Create & Submit ────────────────────────────────────────────────────

  async createDeadDrop(content: string, options?: { zone?: string; parentDropId?: string; isFlare?: boolean }): Promise<{ drop: DeadDrop; warning?: string }> {
    if (!content || content.length > MAX_DROP_LENGTH) {
      throw new Error(`Drop content must be 1-${MAX_DROP_LENGTH} characters`);
    }

    // Derive today's network key and encrypt content
    const networkKey = deriveNetworkKey();
    const plaintext = new TextEncoder().encode(content);
    const encrypted = encryptWithGroupKey(plaintext, networkKey);

    const dropId = crypto.randomUUID();
    const ciphertext = Buffer.from(encrypted.ciphertext).toString('base64');
    const nonce = Buffer.from(encrypted.nonce).toString('base64');
    const authTag = Buffer.from(encrypted.authTag).toString('base64');

    // Compute proof of work with adaptive difficulty
    const difficulty = await this.getAdaptiveDifficulty();
    const challenge = dropId + ciphertext;
    const pow = computePoW(challenge, difficulty);

    const drop: DeadDrop = {
      dropId,
      ciphertext,
      nonce,
      authTag,
      timestamp: 0,       // exit relay stamps this
      expiresAt: 0,        // exit relay sets this
      proofOfWork: pow.hash,
      powNonce: pow.nonce,
      votes: 0,
      difficulty,
      zone: options?.zone || 'signals',
      parentDropId: options?.parentDropId,
      isFlare: options?.isFlare || false,
    };

    // Pick relay peers for onion routing
    const connectedPeers = this.node.getConnectedPeers()
      .filter(p => p.decentraId && p.profile?.encryptionPublicKey);

    if (connectedPeers.length === 0) {
      // No peers — stamp ourselves and store directly (NO anonymity)
      drop.timestamp = Date.now();
      drop.expiresAt = drop.timestamp + DROP_EXPIRY_MS;
      await this.store.storeDeadDrop(drop);
      this.seenDropIds.set(drop.dropId, Date.now());
      const decrypted = this.decryptDrop(drop);
      if (decrypted) {
        for (const cb of this.onNewDrop) cb(drop, decrypted);
      }
      return { drop, warning: 'No connected peers — your drop was stored locally with no anonymity protection.' };
    }

    if (connectedPeers.length < RELAY_HOP_COUNT) {
      // Not enough peers for full onion — broadcast directly (REDUCED anonymity)
      drop.timestamp = Date.now();
      drop.expiresAt = drop.timestamp + DROP_EXPIRY_MS;
      const dropData = new TextEncoder().encode(JSON.stringify(drop));
      await this.node.broadcastToAll(PROTOCOLS.DEAD_DROP_BROADCAST, dropData);
      await this.store.storeDeadDrop(drop);
      this.seenDropIds.set(drop.dropId, Date.now());
      const decrypted = this.decryptDrop(drop);
      if (decrypted) {
        for (const cb of this.onNewDrop) cb(drop, decrypted);
      }
      return { drop, warning: `Only ${connectedPeers.length} peer(s) connected (need ${RELAY_HOP_COUNT} for anonymous routing). Your drop may be traceable.` };
    }

    // Pick 3 random distinct relay peers
    const shuffled = [...connectedPeers].sort(() => Math.random() - 0.5);
    const relays = shuffled.slice(0, RELAY_HOP_COUNT);

    // Build onion: relays[0]=entry, relays[1]=middle, relays[2]=exit
    const dropPayload = JSON.stringify(drop);
    const onionPacket = this.buildOnion(dropPayload, relays.map(r => ({
      decentraId: r.decentraId!,
      encryptionPublicKey: r.profile!.encryptionPublicKey,
    })));

    // Send outermost layer to entry relay
    const entryId = relays[0].decentraId!;
    const data = new TextEncoder().encode(onionPacket);
    await this.node.sendToPeer(entryId, PROTOCOLS.DEAD_DROP_RELAY, data);

    return { drop };
  }

  // ─── Onion Construction ─────────────────────────────────────────────────

  private buildOnion(payload: string, relays: { decentraId: string; encryptionPublicKey: Uint8Array }[]): string {
    // Work backwards: exit → middle → entry
    // Exit layer: nextHop='' (this is the exit), innerPayload=the drop JSON
    let currentLayer = JSON.stringify({
      nextHop: '',
      innerPayload: payload,
    } as OnionLayer);

    // Encrypt for exit relay
    let encrypted = encryptForPeer(
      new TextEncoder().encode(currentLayer),
      relays[2].encryptionPublicKey,
    );
    let encryptedStr = JSON.stringify({
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(encrypted.authTag).toString('base64'),
    });

    // Middle layer: nextHop=exit relay, innerPayload=encrypted exit layer
    currentLayer = JSON.stringify({
      nextHop: relays[2].decentraId,
      innerPayload: encryptedStr,
    } as OnionLayer);

    encrypted = encryptForPeer(
      new TextEncoder().encode(currentLayer),
      relays[1].encryptionPublicKey,
    );
    encryptedStr = JSON.stringify({
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(encrypted.authTag).toString('base64'),
    });

    // Entry layer: nextHop=middle relay, innerPayload=encrypted middle layer
    currentLayer = JSON.stringify({
      nextHop: relays[1].decentraId,
      innerPayload: encryptedStr,
    } as OnionLayer);

    encrypted = encryptForPeer(
      new TextEncoder().encode(currentLayer),
      relays[0].encryptionPublicKey,
    );

    return JSON.stringify({
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(encrypted.authTag).toString('base64'),
    });
  }

  // ─── Relay Handler ──────────────────────────────────────────────────────

  async handleRelayMessage(data: string): Promise<void> {
    try {
      const encPayload = JSON.parse(data);
      const decrypted = decryptFromPeer(
        {
          ciphertext: new Uint8Array(Buffer.from(encPayload.ciphertext, 'base64')),
          nonce: new Uint8Array(Buffer.from(encPayload.nonce, 'base64')),
          ephemeralPublicKey: new Uint8Array(Buffer.from(encPayload.ephemeralPublicKey, 'base64')),
          authTag: new Uint8Array(Buffer.from(encPayload.authTag, 'base64')),
        },
        this.node.getIdentity().encryptionPrivateKey,
      );

      const layer: OnionLayer = JSON.parse(new TextDecoder().decode(decrypted));

      if (layer.nextHop === '') {
        // We are the exit relay — stamp and broadcast
        const drop: DeadDrop = JSON.parse(layer.innerPayload);
        drop.timestamp = Date.now();
        drop.expiresAt = drop.timestamp + DROP_EXPIRY_MS;

        // Verify PoW
        if (!verifyPoW(drop.dropId + drop.ciphertext, drop.proofOfWork, drop.powNonce, drop.difficulty)) {
          console.warn(`[DeadDrop] Exit relay: invalid PoW for drop ${drop.dropId}`);
          return;
        }

        // Broadcast to all peers
        const dropData = new TextEncoder().encode(JSON.stringify(drop));
        await this.node.broadcastToAll(PROTOCOLS.DEAD_DROP_BROADCAST, dropData);

        // Store locally
        await this.store.storeDeadDrop(drop);
        this.seenDropIds.set(drop.dropId, Date.now());
        const content = this.decryptDrop(drop);
        if (content) {
          for (const cb of this.onNewDrop) cb(drop, content);
        }
      } else {
        // We are a middle relay — add random delay and forward
        const delay = RELAY_MIN_DELAY_MS + Math.random() * (RELAY_MAX_DELAY_MS - RELAY_MIN_DELAY_MS);
        setTimeout(async () => {
          try {
            const fwdData = new TextEncoder().encode(layer.innerPayload);
            await this.node.sendToPeer(layer.nextHop, PROTOCOLS.DEAD_DROP_RELAY, fwdData);
          } catch (err) {
            console.warn(`[DeadDrop] Relay forward failed:`, err);
          }
        }, delay);
      }
    } catch (err) {
      console.warn(`[DeadDrop] Relay message handling failed:`, err);
    }
  }

  // ─── Broadcast Handler ──────────────────────────────────────────────────

  async handleIncomingBroadcast(data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);

      // Differentiate between drops and votes by shape
      if (parsed.voteId) {
        await this.handleIncomingVote(parsed as DeadDropVote);
        return;
      }

      const drop = parsed as DeadDrop;

      // Dedup
      if (this.seenDropIds.has(drop.dropId)) return;
      this.seenDropIds.set(drop.dropId, Date.now());

      // Reject expired
      if (drop.expiresAt < Date.now()) return;

      // Verify PoW
      if (!verifyPoW(drop.dropId + drop.ciphertext, drop.proofOfWork, drop.powNonce, drop.difficulty)) {
        console.warn(`[DeadDrop] Invalid PoW for drop ${drop.dropId}`);
        return;
      }

      // Store
      await this.store.storeDeadDrop(drop);

      // Decrypt and notify UI
      const content = this.decryptDrop(drop);
      if (content) {
        for (const cb of this.onNewDrop) cb(drop, content);
      }

      // Re-gossip to connected peers
      const dropData = new TextEncoder().encode(JSON.stringify(drop));
      await this.node.broadcastToAll(PROTOCOLS.DEAD_DROP_BROADCAST, dropData);
    } catch (err) {
      console.warn(`[DeadDrop] Broadcast handling failed:`, err);
    }
  }

  // ─── Vote Handling ──────────────────────────────────────────────────────

  private async handleIncomingVote(vote: DeadDropVote): Promise<void> {
    if (this.seenVoteIds.has(vote.voteId)) return;
    this.seenVoteIds.set(vote.voteId, Date.now());

    const drop = await this.store.getDeadDrop(vote.dropId);
    if (!drop) return;

    const delta = vote.direction === 'up' ? 1 : -1;
    await this.store.updateDropVotes(vote.dropId, drop.votes + delta);

    // Re-gossip vote
    const voteData = new TextEncoder().encode(JSON.stringify(vote));
    await this.node.broadcastToAll(PROTOCOLS.DEAD_DROP_BROADCAST, voteData);
  }

  async voteDrop(dropId: string, direction: 'up' | 'down'): Promise<number> {
    const hasVoted = await this.store.hasVotedOnDrop(dropId);
    if (hasVoted) throw new Error('Already voted on this drop');

    const drop = await this.store.getDeadDrop(dropId);
    if (!drop) throw new Error('Drop not found');

    const vote: DeadDropVote = {
      dropId,
      voteId: crypto.randomUUID(),
      direction,
      timestamp: Date.now(),
    };

    await this.store.recordDropVote(vote);

    const delta = direction === 'up' ? 1 : -1;
    const newVotes = drop.votes + delta;
    await this.store.updateDropVotes(dropId, newVotes);

    // Broadcast vote
    const voteData = new TextEncoder().encode(JSON.stringify(vote));
    await this.node.broadcastToAll(PROTOCOLS.DEAD_DROP_BROADCAST, voteData);

    return newVotes;
  }

  // ─── Decryption ─────────────────────────────────────────────────────────

  decryptDrop(drop: DeadDrop): string | null {
    // Try today's key first, then yesterday's (midnight boundary)
    const today = deriveNetworkKey();
    const yesterday = deriveNetworkKey(getDateString(-1));

    for (const key of [today, yesterday]) {
      try {
        const plaintext = decryptWithGroupKey(
          new Uint8Array(Buffer.from(drop.ciphertext, 'base64')),
          new Uint8Array(Buffer.from(drop.nonce, 'base64')),
          new Uint8Array(Buffer.from(drop.authTag, 'base64')),
          key,
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        // Try next key
      }
    }
    return null;
  }

  dispose(): void {
    clearInterval(this.pruneTimer);
  }
}

// ─── Network Key Derivation ───────────────────────────────────────────────────

function deriveNetworkKey(dateStr?: string): Uint8Array {
  const date = dateStr || new Date().toISOString().split('T')[0];
  const hmac = crypto.createHmac('sha256', NETWORK_KEY_CONTEXT);
  hmac.update(date);
  return new Uint8Array(hmac.digest());
}

function getDateString(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

// ─── Proof of Work ────────────────────────────────────────────────────────────

function computePoW(challenge: string, difficulty: number = POW_DIFFICULTY_BASE): { hash: string; nonce: number } {
  let nonce = 0;
  while (true) {
    const hash = crypto.createHash('sha256')
      .update(challenge + nonce.toString())
      .digest('hex');
    if (hasLeadingZeroBits(hash, difficulty)) {
      return { hash, nonce };
    }
    nonce++;
  }
}

function verifyPoW(challenge: string, hash: string, nonce: number, claimedDifficulty?: number): boolean {
  // Accept any difficulty >= baseline (can't reject higher PoW)
  const diff = Math.max(claimedDifficulty || POW_DIFFICULTY_BASE, POW_DIFFICULTY_BASE);
  const computed = crypto.createHash('sha256')
    .update(challenge + nonce.toString())
    .digest('hex');
  return computed === hash && hasLeadingZeroBits(computed, diff);
}

function hasLeadingZeroBits(hexHash: string, bits: number): boolean {
  // Each hex char = 4 bits
  const fullHexChars = Math.floor(bits / 4);
  const remainingBits = bits % 4;

  for (let i = 0; i < fullHexChars; i++) {
    if (hexHash[i] !== '0') return false;
  }

  if (remainingBits > 0) {
    const nibble = parseInt(hexHash[fullHexChars], 16);
    // Check that the top `remainingBits` bits of this nibble are zero
    const mask = (0xF << (4 - remainingBits)) & 0xF;
    if ((nibble & mask) !== 0) return false;
  }

  return true;
}
