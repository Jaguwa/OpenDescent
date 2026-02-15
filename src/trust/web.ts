/**
 * Trust Web Service — Cryptographic web of trust via vouching
 *
 * Users vouch for friends they trust. Vouches gossip through the network
 * (up to maxHops). BFS finds trust paths between any two users, giving
 * a decentralized reputation signal with no central authority.
 */

import * as crypto from 'crypto';
import type { DecentraNode } from '../network/node.js';
import { PROTOCOLS } from '../network/node.js';
import type { LocalStore } from '../storage/store.js';
import type { Vouch, VouchRevocation, TrustPathResult, TrustPathNode, PeerId } from '../types/index.js';
import { sign, verify } from '../crypto/identity.js';

const MAX_HOPS = 3;
const MAX_SEEN_VOUCHES = 5000;
const MAX_BFS_DEPTH = 6;

export class TrustWebService {
  private node: DecentraNode;
  private store: LocalStore;
  private seenVouchIds: Map<string, number> = new Map();

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;

    // Prune seen vouches every 10 minutes
    setInterval(() => this.pruneSeenVouches(), 10 * 60 * 1000);
  }

  /** Vouch for a peer (must be a friend) */
  async vouchForPeer(toId: PeerId, message?: string): Promise<Vouch> {
    const myId = this.node.getPeerId();

    // Must be a friend
    const isFriend = await this.store.isFriend(toId);
    if (!isFriend) {
      throw new Error('Can only vouch for friends');
    }

    // Check not already vouched
    const existing = await this.store.getVouchByPair(myId, toId);
    if (existing) {
      throw new Error('Already vouched for this peer');
    }

    const targetProfile = this.node.getKnownPeer(toId);

    const vouch: Vouch = {
      vouchId: crypto.randomUUID(),
      fromId: myId,
      toId,
      fromName: this.node.getIdentity().displayName,
      toName: targetProfile?.displayName,
      message,
      timestamp: Date.now(),
      signature: '',
      hopCount: 0,
      maxHops: MAX_HOPS,
    };

    // Sign the vouch
    const sigData = getVouchSignableData(vouch);
    vouch.signature = Buffer.from(sign(sigData, this.node.getIdentity().privateKey)).toString('base64');

    // Store locally
    await this.store.storeVouch(vouch);
    this.seenVouchIds.set(vouch.vouchId, vouch.timestamp);

    // Broadcast to peers
    const data = new TextEncoder().encode(JSON.stringify(vouch));
    await this.node.broadcastToAll(PROTOCOLS.VOUCH_BROADCAST, data);

    console.log(`[TrustWeb] Vouched for ${targetProfile?.displayName || toId.slice(0, 12)}`);
    return vouch;
  }

  /** Revoke a vouch we previously issued */
  async revokeVouch(vouchId: string): Promise<void> {
    const vouch = await this.store.getVouch(vouchId);
    if (!vouch) {
      throw new Error('Vouch not found');
    }

    const myId = this.node.getPeerId();
    if (vouch.fromId !== myId) {
      throw new Error('Can only revoke your own vouches');
    }

    const revocation: VouchRevocation = {
      revocationId: crypto.randomUUID(),
      vouchId,
      fromId: myId,
      timestamp: Date.now(),
      signature: '',
    };

    // Sign the revocation
    const sigData = getRevocationSignableData(revocation);
    revocation.signature = Buffer.from(sign(sigData, this.node.getIdentity().privateKey)).toString('base64');

    // Apply locally (deletes vouch + index)
    await this.store.revokeVouch(revocation);

    // Broadcast revocation
    const data = new TextEncoder().encode(JSON.stringify(revocation));
    await this.node.broadcastToAll(PROTOCOLS.VOUCH_BROADCAST, data);

    console.log(`[TrustWeb] Revoked vouch ${vouchId}`);
  }

  /** Handle incoming vouch or revocation from the network */
  async handleIncomingVouch(data: string): Promise<void> {
    try {
      const msg = JSON.parse(data);

      // Determine if this is a Vouch or VouchRevocation
      if (msg.revocationId) {
        await this.handleRevocation(msg as VouchRevocation);
      } else if (msg.vouchId) {
        await this.handleVouch(msg as Vouch);
      }
    } catch (error) {
      console.error('[TrustWeb] Error handling incoming vouch:', error);
    }
  }

  private async handleVouch(vouch: Vouch): Promise<void> {
    // Dedup
    if (this.seenVouchIds.has(vouch.vouchId)) return;

    // Check if already revoked
    if (await this.store.isRevoked(vouch.vouchId)) return;

    // Cap maxHops
    if (vouch.maxHops > MAX_HOPS) vouch.maxHops = MAX_HOPS;

    // Verify signature if we have the author's public key
    if (vouch.signature) {
      const authorProfile = this.node.getKnownPeer(vouch.fromId);
      if (authorProfile) {
        const sigData = getVouchSignableData(vouch);
        const sigBytes = new Uint8Array(Buffer.from(vouch.signature, 'base64'));
        if (!verify(sigData, sigBytes, authorProfile.publicKey)) {
          console.warn(`[TrustWeb] Dropping vouch ${vouch.vouchId}: invalid signature from ${vouch.fromId}`);
          return;
        }
      }
    }

    this.seenVouchIds.set(vouch.vouchId, vouch.timestamp);

    // Store locally
    await this.store.storeVouch(vouch);

    // Re-gossip if under max hops
    if (vouch.hopCount < vouch.maxHops) {
      const forwarded = { ...vouch, hopCount: vouch.hopCount + 1 };
      const fwdData = new TextEncoder().encode(JSON.stringify(forwarded));
      await this.node.broadcastToAll(PROTOCOLS.VOUCH_BROADCAST, fwdData);
    }
  }

  private async handleRevocation(revocation: VouchRevocation): Promise<void> {
    // Verify signature matches the original vouch author
    if (revocation.signature) {
      const authorProfile = this.node.getKnownPeer(revocation.fromId);
      if (authorProfile) {
        const sigData = getRevocationSignableData(revocation);
        const sigBytes = new Uint8Array(Buffer.from(revocation.signature, 'base64'));
        if (!verify(sigData, sigBytes, authorProfile.publicKey)) {
          console.warn(`[TrustWeb] Dropping revocation: invalid signature from ${revocation.fromId}`);
          return;
        }
      }
    }

    // Apply revocation
    await this.store.revokeVouch(revocation);

    // Re-gossip revocation
    const data = new TextEncoder().encode(JSON.stringify(revocation));
    await this.node.broadcastToAll(PROTOCOLS.VOUCH_BROADCAST, data);
  }

  /** Find a trust path between two peers via BFS */
  async findTrustPath(fromId: PeerId, toId: PeerId): Promise<TrustPathResult> {
    if (fromId === toId) {
      return { found: true, path: [this.makePathNode(fromId)], distance: 0 };
    }

    // Build adjacency list from all vouches
    const vouches = await this.store.getAllVouches();
    const adj = new Map<string, Set<string>>();
    for (const v of vouches) {
      if (!adj.has(v.fromId)) adj.set(v.fromId, new Set());
      adj.get(v.fromId)!.add(v.toId);
    }

    // BFS
    const visited = new Set<string>();
    const parent = new Map<string, string>();
    const queue: string[] = [fromId];
    visited.add(fromId);

    let found = false;
    let depth = 0;

    while (queue.length > 0 && depth < MAX_BFS_DEPTH) {
      const levelSize = queue.length;
      depth++;

      for (let i = 0; i < levelSize; i++) {
        const current = queue.shift()!;
        const neighbors = adj.get(current);
        if (!neighbors) continue;

        for (const neighbor of neighbors) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          parent.set(neighbor, current);

          if (neighbor === toId) {
            found = true;
            break;
          }
          queue.push(neighbor);
        }
        if (found) break;
      }
      if (found) break;
    }

    if (!found) {
      return { found: false, path: [], distance: -1 };
    }

    // Reconstruct path
    const path: TrustPathNode[] = [];
    let current = toId;
    while (current) {
      path.unshift(this.makePathNode(current));
      const p = parent.get(current);
      if (!p) break;
      current = p;
    }

    return { found: true, path, distance: path.length - 1 };
  }

  /** Get all vouches given by and received by a peer */
  async getVouchGraph(peerId: PeerId): Promise<{ given: Vouch[]; received: Vouch[] }> {
    const [given, received] = await Promise.all([
      this.store.getVouchesFrom(peerId),
      this.store.getVouchesFor(peerId),
    ]);
    return { given, received };
  }

  private makePathNode(peerId: PeerId): TrustPathNode {
    const profile = this.node.getKnownPeer(peerId);
    return {
      peerId,
      displayName: profile?.displayName || (peerId === this.node.getPeerId() ? this.node.getIdentity().displayName : undefined),
    };
  }

  private pruneSeenVouches(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, ts] of this.seenVouchIds) {
      if (ts < cutoff) this.seenVouchIds.delete(id);
    }
    if (this.seenVouchIds.size > MAX_SEEN_VOUCHES) {
      const entries = [...this.seenVouchIds.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, entries.length - MAX_SEEN_VOUCHES);
      for (const [id] of toRemove) this.seenVouchIds.delete(id);
    }
  }
}

// ─── Signing Helpers ──────────────────────────────────────────────────────────

function getVouchSignableData(vouch: Vouch): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    vouchId: vouch.vouchId,
    fromId: vouch.fromId,
    toId: vouch.toId,
    fromName: vouch.fromName || '',
    toName: vouch.toName || '',
    message: vouch.message || '',
    timestamp: vouch.timestamp,
    maxHops: vouch.maxHops,
  }));
}

function getRevocationSignableData(revocation: VouchRevocation): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    revocationId: revocation.revocationId,
    vouchId: revocation.vouchId,
    fromId: revocation.fromId,
    timestamp: revocation.timestamp,
  }));
}
