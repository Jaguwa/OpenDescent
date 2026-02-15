/**
 * Encrypted Polls — Verifiable Private Voting
 *
 * Each vote is encrypted with the creator's X25519 public key.
 * Only the creator can decrypt individual votes. Results are published
 * with a commit-reveal cryptographic proof (SHA-256(voteSecret || optionIndex))
 * so every voter can verify their vote was counted correctly.
 */

import * as crypto from 'crypto';
import { encryptForPeer, decryptFromPeer, type EncryptedPayload } from '../crypto/encryption.js';
import { sign, verify } from '../crypto/identity.js';
import { PROTOCOLS, type DecentraNode } from '../network/node.js';
import type { LocalStore } from '../storage/store.js';
import type { Poll, PollResults, PollVoteReceipt, EncryptedVote, VotePlaintext, PollScope } from '../types/index.js';

const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;
const MIN_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPTIONS = 10;
const MAX_QUESTION_LENGTH = 500;
const MAX_OPTION_LENGTH = 200;
const MAX_HOPS = 5;

export class PollService {
  private node: DecentraNode;
  private store: LocalStore;
  private seenPollIds: Map<string, number> = new Map();
  private seenResultIds: Map<string, number> = new Map();
  private pruneTimer: ReturnType<typeof setInterval>;

  onNewPoll: Array<(poll: Poll) => void> = [];
  onPollResults: Array<(poll: Poll, results: PollResults) => void> = [];
  onVoteReceived: Array<(pollId: string, voterId: string) => void> = [];

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;

    // Prune seen caches every 10 minutes
    this.pruneTimer = setInterval(() => {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [id, ts] of this.seenPollIds) {
        if (ts < cutoff) this.seenPollIds.delete(id);
      }
      for (const [id, ts] of this.seenResultIds) {
        if (ts < cutoff) this.seenResultIds.delete(id);
      }
    }, 10 * 60 * 1000);
  }

  // ─── Create Poll ──────────────────────────────────────────────────────

  async createPoll(
    question: string,
    options: string[],
    durationMs?: number,
    scope?: PollScope,
    groupId?: string,
  ): Promise<Poll> {
    if (!question || question.length > MAX_QUESTION_LENGTH) {
      throw new Error(`Question must be 1-${MAX_QUESTION_LENGTH} characters`);
    }
    if (options.length < 2 || options.length > MAX_OPTIONS) {
      throw new Error(`Must have 2-${MAX_OPTIONS} options`);
    }
    for (const opt of options) {
      if (!opt || opt.length > MAX_OPTION_LENGTH) {
        throw new Error(`Each option must be 1-${MAX_OPTION_LENGTH} characters`);
      }
    }

    const duration = Math.min(Math.max(durationMs || DEFAULT_DURATION_MS, MIN_DURATION_MS), MAX_DURATION_MS);
    const now = Date.now();
    const pollScope = scope || 'public';

    const poll: Poll = {
      pollId: crypto.randomUUID(),
      creatorId: this.node.getPeerId(),
      creatorName: this.node.getIdentity().displayName,
      question,
      options,
      scope: pollScope,
      groupId: pollScope === 'group' ? groupId : undefined,
      status: 'open',
      createdAt: now,
      expiresAt: now + duration,
      durationMs: duration,
      voteCount: 0,
      signature: '',
      hopCount: 0,
      maxHops: pollScope === 'group' ? 1 : 3,
    };

    // Sign immutable fields
    const signData = this.getPollSignData(poll);
    poll.signature = Buffer.from(sign(signData, this.node.getIdentity().privateKey)).toString('base64');

    await this.store.storePoll(poll);
    this.seenPollIds.set(poll.pollId, now);

    // Broadcast
    const broadcastData = new TextEncoder().encode(JSON.stringify({ type: 'poll', ...poll }));
    await this.node.broadcastToAll(PROTOCOLS.POLL_BROADCAST, broadcastData);

    return poll;
  }

  // ─── Cast Vote ────────────────────────────────────────────────────────

  async castVote(pollId: string, optionIndex: number): Promise<PollVoteReceipt> {
    const poll = await this.store.getPoll(pollId);
    if (!poll) throw new Error('Poll not found');
    if (poll.status !== 'open') throw new Error('Poll is not open');
    if (poll.expiresAt < Date.now()) throw new Error('Poll has expired');
    if (optionIndex < 0 || optionIndex >= poll.options.length) throw new Error('Invalid option index');

    // Prevent double-voting locally
    const existing = await this.store.getVoteReceipt(pollId);
    if (existing) throw new Error('Already voted on this poll');

    // Generate vote secret
    const voteSecret = crypto.randomBytes(32).toString('base64');

    // Build plaintext
    const plaintext: VotePlaintext = { pollId, optionIndex, voteSecret };
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));

    // Get creator's encryption public key
    const creatorProfile = this.node.getKnownPeer(poll.creatorId);
    if (!creatorProfile) throw new Error('Creator profile not found — cannot encrypt vote');

    // Encrypt with creator's X25519 key
    const encrypted = encryptForPeer(plaintextBytes, creatorProfile.encryptionPublicKey);

    // Serialize EncryptedPayload to base64 JSON
    const encPayloadStr = JSON.stringify({
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
      nonce: Buffer.from(encrypted.nonce).toString('base64'),
      ephemeralPublicKey: Buffer.from(encrypted.ephemeralPublicKey).toString('base64'),
      authTag: Buffer.from(encrypted.authTag).toString('base64'),
    });

    const vote: EncryptedVote = {
      pollId,
      voterId: this.node.getPeerId(),
      encryptedPayload: encPayloadStr,
      timestamp: Date.now(),
    };

    // Send directly to creator
    const voteData = new TextEncoder().encode(JSON.stringify(vote));
    await this.node.sendToPeer(poll.creatorId, PROTOCOLS.POLL_VOTE, voteData);

    // Store receipt locally
    const receipt: PollVoteReceipt = {
      pollId,
      optionIndex,
      voteSecret,
      timestamp: vote.timestamp,
    };
    await this.store.storeVoteReceipt(receipt);

    return receipt;
  }

  // ─── Handle Incoming Broadcast ────────────────────────────────────────

  async handleIncomingBroadcast(data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'poll') {
        await this.handleIncomingPoll(parsed);
      } else if (parsed.type === 'results') {
        await this.handleIncomingResults(parsed);
      }
    } catch (e) {
      console.error('[Polls] Error handling broadcast:', e);
    }
  }

  private async handleIncomingPoll(parsed: any): Promise<void> {
    const pollId = parsed.pollId;
    if (!pollId || this.seenPollIds.has(pollId)) return;
    this.seenPollIds.set(pollId, Date.now());

    // Reject expired
    if (parsed.expiresAt < Date.now()) return;

    // Verify signature if we know the creator
    const creatorProfile = this.node.getKnownPeer(parsed.creatorId);
    if (creatorProfile && parsed.signature) {
      const signData = this.getPollSignData(parsed as Poll);
      const sigBytes = new Uint8Array(Buffer.from(parsed.signature, 'base64'));
      if (!verify(signData, sigBytes, creatorProfile.publicKey)) {
        console.warn(`[Polls] Rejected poll ${pollId}: invalid signature`);
        return;
      }
    }

    // Strip broadcast wrapper type, store as Poll
    const poll: Poll = {
      pollId: parsed.pollId,
      creatorId: parsed.creatorId,
      creatorName: parsed.creatorName,
      question: parsed.question,
      options: parsed.options,
      scope: parsed.scope || 'public',
      groupId: parsed.groupId,
      status: parsed.status || 'open',
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      durationMs: parsed.durationMs,
      voteCount: 0, // we don't trust remote vote counts
      signature: parsed.signature,
      hopCount: parsed.hopCount || 0,
      maxHops: parsed.maxHops || 3,
    };

    await this.store.storePoll(poll);
    for (const cb of this.onNewPoll) cb(poll);

    // Re-gossip if under hop limit
    if (poll.hopCount < poll.maxHops) {
      const regossip = { ...parsed, hopCount: poll.hopCount + 1 };
      const data = new TextEncoder().encode(JSON.stringify(regossip));
      await this.node.broadcastToAll(PROTOCOLS.POLL_BROADCAST, data);
    }
  }

  // ─── Handle Incoming Vote ─────────────────────────────────────────────

  async handleIncomingVote(data: string): Promise<void> {
    try {
      const vote: EncryptedVote = JSON.parse(data);
      const poll = await this.store.getPoll(vote.pollId);
      if (!poll) return;

      // We must be the creator
      if (poll.creatorId !== this.node.getPeerId()) return;

      // Dedup
      if (await this.store.hasVoteFrom(vote.pollId, vote.voterId)) return;

      // Reject if expired or not open
      if (poll.status !== 'open' || poll.expiresAt < Date.now()) return;

      // Store (decrypt at tally time)
      await this.store.storeEncryptedVote(vote);
      poll.voteCount++;
      await this.store.storePoll(poll);

      for (const cb of this.onVoteReceived) cb(vote.pollId, vote.voterId);
    } catch (e) {
      console.error('[Polls] Error handling vote:', e);
    }
  }

  // ─── Tally ────────────────────────────────────────────────────────────

  async tallyPoll(pollId: string): Promise<PollResults> {
    const poll = await this.store.getPoll(pollId);
    if (!poll) throw new Error('Poll not found');
    if (poll.creatorId !== this.node.getPeerId()) throw new Error('Only the creator can tally');
    if (poll.status === 'tallied') throw new Error('Poll already tallied');

    // Close the poll
    poll.status = 'closed';
    await this.store.storePoll(poll);

    // Get all encrypted votes
    const encryptedVotes = await this.store.getVotesForPoll(pollId);
    const tally = new Array(poll.options.length).fill(0);
    const proofHashes: string[] = [];

    for (const ev of encryptedVotes) {
      try {
        // Parse encrypted payload
        const payloadObj = JSON.parse(ev.encryptedPayload);
        const encPayload: EncryptedPayload = {
          ciphertext: new Uint8Array(Buffer.from(payloadObj.ciphertext, 'base64')),
          nonce: new Uint8Array(Buffer.from(payloadObj.nonce, 'base64')),
          ephemeralPublicKey: new Uint8Array(Buffer.from(payloadObj.ephemeralPublicKey, 'base64')),
          authTag: new Uint8Array(Buffer.from(payloadObj.authTag, 'base64')),
        };

        // Decrypt
        const decrypted = decryptFromPeer(encPayload, this.node.getIdentity().encryptionPrivateKey);
        const plaintext: VotePlaintext = JSON.parse(new TextDecoder().decode(decrypted));

        // Validate
        if (plaintext.pollId !== pollId) continue;
        if (plaintext.optionIndex < 0 || plaintext.optionIndex >= poll.options.length) continue;

        tally[plaintext.optionIndex]++;

        // Compute proof hash: SHA-256(voteSecret || optionIndex)
        const hashInput = Buffer.concat([
          Buffer.from(plaintext.voteSecret, 'base64'),
          Buffer.from([plaintext.optionIndex]),
        ]);
        const proofHash = crypto.createHash('sha256').update(hashInput).digest('hex');
        proofHashes.push(proofHash);
      } catch (e) {
        console.warn('[Polls] Failed to decrypt vote:', e);
      }
    }

    // Fisher-Yates shuffle proof hashes
    for (let i = proofHashes.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [proofHashes[i], proofHashes[j]] = [proofHashes[j], proofHashes[i]];
    }

    // Sign results
    const resultsSignData = new TextEncoder().encode(JSON.stringify({ pollId, tally, proofHashes }));
    const tallySignature = Buffer.from(sign(resultsSignData, this.node.getIdentity().privateKey)).toString('base64');

    const results: PollResults = {
      pollId,
      creatorId: this.node.getPeerId(),
      tally,
      proofHashes,
      tallySignature,
      publishedAt: Date.now(),
    };

    await this.store.storePollResults(results);
    poll.status = 'tallied';
    await this.store.storePoll(poll);

    // Broadcast results
    const broadcastData = new TextEncoder().encode(JSON.stringify({ type: 'results', ...results }));
    await this.node.broadcastToAll(PROTOCOLS.POLL_BROADCAST, broadcastData);

    for (const cb of this.onPollResults) cb(poll, results);

    return results;
  }

  // ─── Handle Incoming Results ──────────────────────────────────────────

  private async handleIncomingResults(parsed: any): Promise<void> {
    const pollId = parsed.pollId;
    if (!pollId || this.seenResultIds.has(pollId)) return;
    this.seenResultIds.set(pollId, Date.now());

    // Verify signature
    const creatorProfile = this.node.getKnownPeer(parsed.creatorId);
    if (creatorProfile && parsed.tallySignature) {
      const sigData = new TextEncoder().encode(JSON.stringify({
        pollId: parsed.pollId,
        tally: parsed.tally,
        proofHashes: parsed.proofHashes,
      }));
      const sigBytes = new Uint8Array(Buffer.from(parsed.tallySignature, 'base64'));
      if (!verify(sigData, sigBytes, creatorProfile.publicKey)) {
        console.warn(`[Polls] Rejected results for ${pollId}: invalid signature`);
        return;
      }
    }

    // Verify proof count matches tally
    const tallySum = (parsed.tally as number[]).reduce((a, b) => a + b, 0);
    if (parsed.proofHashes.length !== tallySum) {
      console.warn(`[Polls] Rejected results for ${pollId}: proof count mismatch`);
      return;
    }

    const results: PollResults = {
      pollId: parsed.pollId,
      creatorId: parsed.creatorId,
      tally: parsed.tally,
      proofHashes: parsed.proofHashes,
      tallySignature: parsed.tallySignature,
      publishedAt: parsed.publishedAt,
    };

    await this.store.storePollResults(results);

    // Update poll status
    const poll = await this.store.getPoll(pollId);
    if (poll) {
      poll.status = 'tallied';
      await this.store.storePoll(poll);
      for (const cb of this.onPollResults) cb(poll, results);
    }

    // Re-gossip
    const regossipData = new TextEncoder().encode(JSON.stringify(parsed));
    await this.node.broadcastToAll(PROTOCOLS.POLL_BROADCAST, regossipData);
  }

  // ─── Verify Vote ──────────────────────────────────────────────────────

  async verifyMyVote(pollId: string): Promise<{ verified: boolean; message: string }> {
    const receipt = await this.store.getVoteReceipt(pollId);
    if (!receipt) return { verified: false, message: 'No vote receipt found — you may not have voted on this poll' };

    const results = await this.store.getPollResults(pollId);
    if (!results) return { verified: false, message: 'Results not yet published' };

    // Recompute SHA-256(voteSecret || optionIndex)
    const hashInput = Buffer.concat([
      Buffer.from(receipt.voteSecret, 'base64'),
      Buffer.from([receipt.optionIndex]),
    ]);
    const myHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    if (results.proofHashes.includes(myHash)) {
      return { verified: true, message: 'Your vote was counted correctly' };
    } else {
      return { verified: false, message: 'Your vote hash was NOT found in the published proofs — the creator may have cheated' };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private getPollSignData(poll: Poll): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      pollId: poll.pollId,
      creatorId: poll.creatorId,
      question: poll.question,
      options: poll.options,
      scope: poll.scope,
      groupId: poll.groupId,
      createdAt: poll.createdAt,
      expiresAt: poll.expiresAt,
      durationMs: poll.durationMs,
      maxHops: poll.maxHops,
    }));
  }
}
