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
import type { Shard, MessageEnvelope, PeerProfile, ContentManifest, PeerId, AccountBundle, PinnedKey, ThemePreferences, UserProfile, FriendRequest, Post, PostReaction, PostComment, Vouch, VouchRevocation, DeadDrop, DeadDropVote, Poll, EncryptedVote, PollResults, PollVoteReceipt, Hub, HubCategory, HubChannel, HubMember, HubInvite, HubListing, HubStats, DeadManSwitch } from '../types/index.js';

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

const SCHEMA_VERSION = 2; // Increment when changing storage format

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
  PROFILE: 'profile:',
  FRIEND: 'friend:',
  FRIEND_REQ: 'friendreq:',
  POST: 'post:',
  POST_IDX: 'postidx:',
  REACTION: 'reaction:',
  COMMENT: 'comment:',
  VOUCH: 'vouch:',
  VOUCH_IDX: 'vouchidx:',
  VOUCH_REV: 'vouchrev:',
  DEAD_DROP: 'ddrop:',
  DEAD_DROP_IDX: 'ddropidx:',
  DEAD_DROP_VOTE: 'ddropvote:',
  POLL: 'poll:',
  POLL_IDX: 'pollidx:',
  POLL_VOTE: 'pollvote:',
  POLL_RECEIPT: 'pollreceipt:',
  POLL_RESULTS: 'pollresults:',
  HUB: 'hub:',
  HUB_CATEGORY: 'hubcat:',
  HUB_CHANNEL: 'hubch:',
  HUB_MEMBER: 'hubmem:',
  HUB_INVITE: 'hubinv:',
  HUB_LISTING: 'hublst:',
  HUB_STATS: 'hubstats:',
  SEALED: 'sealed:',
  BLOCK: 'block:',
  HUB_STATS_SNAP: 'hubsnap:',
  REPORT: 'report:',
  DMS: 'dms:',
  LAST_READ: 'lastread:',
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

    // Schema version check — detect and handle upgrades
    try {
      const storedVersion = await this.db.get(`${NS.META}schema_version`);
      const ver = parseInt(storedVersion, 10);
      if (ver < SCHEMA_VERSION) {
        console.log(`[Store] Upgrading schema from v${ver} to v${SCHEMA_VERSION}`);
        await this.db.put(`${NS.META}schema_version`, String(SCHEMA_VERSION));
      }
    } catch {
      // No version stored — first run or pre-versioning DB
      await this.db.put(`${NS.META}schema_version`, String(SCHEMA_VERSION));
    }

    await this.calculateStorageUsage();
    console.log(`[Store] Opened (schema v${SCHEMA_VERSION}). Usage: ${formatBytes(this.currentStorageBytes)} / ${formatBytes(this.maxStorageBytes)}`);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /** Wipe all data: close DB, delete store dir, identity, device key, libp2p key */
  async wipeAll(): Promise<void> {
    await this.db.close();
    const storeDir = path.join(this.dataDir, 'store');
    if (fs.existsSync(storeDir)) fs.rmSync(storeDir, { recursive: true, force: true });
    const identityFile = path.join(this.dataDir, 'identity.json');
    if (fs.existsSync(identityFile)) fs.unlinkSync(identityFile);
    const deviceKeyFile = path.join(this.dataDir, '.device-key');
    if (fs.existsSync(deviceKeyFile)) fs.unlinkSync(deviceKeyFile);
    const libp2pKeyFile = path.join(this.dataDir, 'libp2p-key');
    if (fs.existsSync(libp2pKeyFile)) fs.unlinkSync(libp2pKeyFile);
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

  // ─── Sealed Message Queue (Sealed Sender Store-and-Forward) ────────────

  async queueSealedMessage(recipientId: PeerId, messageId: string, sealedData: string): Promise<void> {
    const key = NS.SEALED + recipientId + ':' + messageId;
    await this.db.put(key, JSON.stringify({ sealed: sealedData, queuedAt: Date.now() }));
  }

  async getSealedMessages(recipientId: PeerId): Promise<{ messageId: string; sealed: string }[]> {
    const prefix = NS.SEALED + recipientId + ':';
    const messages: { messageId: string; sealed: string }[] = [];
    for await (const [key, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      const messageId = key.slice(prefix.length);
      const parsed = JSON.parse(value);
      messages.push({ messageId, sealed: parsed.sealed });
    }
    return messages;
  }

  async removeSealedMessage(recipientId: PeerId, messageId: string): Promise<void> {
    await this.db.del(NS.SEALED + recipientId + ':' + messageId);
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

  /** Mark a conversation as read up to now */
  async markConversationRead(conversationId: string): Promise<void> {
    await this.db.put(NS.LAST_READ + conversationId, String(Date.now()));
  }

  /** Get unread message count for a conversation */
  async getUnreadCount(conversationId: string): Promise<number> {
    let lastRead = 0;
    try {
      const val = await this.db.get(NS.LAST_READ + conversationId);
      lastRead = parseInt(val, 10) || 0;
    } catch {}

    const prefix = NS.HISTORY + conversationId + ':';
    let count = 0;
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      const msg = JSON.parse(value);
      if (msg.timestamp > lastRead) count++;
    }
    return count;
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

  async deleteGroup(groupId: string): Promise<void> {
    try { await this.db.del(NS.GROUP + groupId); } catch {}
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

    let themePrefs: ThemePreferences | undefined;
    try {
      const tp = await this.db.get(NS.META + 'themePrefs');
      if (tp) themePrefs = JSON.parse(tp);
    } catch {}

    const bundle: AccountBundle = {
      version: 1,
      peerId,
      contacts,
      groups,
      settings: { displayName, themePrefs },
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
    if (bundle.settings.themePrefs) {
      await this.db.put(NS.META + 'themePrefs', JSON.stringify(bundle.settings.themePrefs));
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

  // ─── Theme Preferences (Phase 1) ────────────────────────────────────────

  async getThemePrefs(): Promise<ThemePreferences | null> {
    try {
      const val = await this.db.get(NS.META + 'themePrefs');
      return JSON.parse(val);
    } catch {
      return null;
    }
  }

  async setThemePrefs(prefs: ThemePreferences): Promise<void> {
    await this.db.put(NS.META + 'themePrefs', JSON.stringify(prefs));
  }

  // ─── User Profile (Phase 2) ───────────────────────────────────────────

  async storeUserProfile(profile: UserProfile): Promise<void> {
    await this.db.put(NS.PROFILE + profile.peerId, JSON.stringify(profile));
  }

  async getUserProfile(peerId: PeerId): Promise<UserProfile | null> {
    try {
      return JSON.parse(await this.db.get(NS.PROFILE + peerId));
    } catch {
      return null;
    }
  }

  // ─── Friend Requests & Friends (Phase 3) ──────────────────────────────

  async storeFriendRequest(req: FriendRequest): Promise<void> {
    await this.db.put(NS.FRIEND_REQ + req.requestId, JSON.stringify(req));
  }

  async getFriendRequest(requestId: string): Promise<FriendRequest | null> {
    try {
      return JSON.parse(await this.db.get(NS.FRIEND_REQ + requestId));
    } catch {
      return null;
    }
  }

  async getPendingFriendRequests(): Promise<FriendRequest[]> {
    const requests: FriendRequest[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.FRIEND_REQ, lt: NS.FRIEND_REQ + '\xFF' })) {
      const req = JSON.parse(value) as FriendRequest;
      if (req.status === 'pending') requests.push(req);
    }
    return requests;
  }

  async addFriend(peerId: PeerId): Promise<void> {
    await this.db.put(NS.FRIEND + peerId, JSON.stringify({ peerId, addedAt: Date.now() }));
  }

  async removeFriend(peerId: PeerId): Promise<void> {
    try { await this.db.del(NS.FRIEND + peerId); } catch {}
  }

  async isFriend(peerId: PeerId): Promise<boolean> {
    try { await this.db.get(NS.FRIEND + peerId); return true; } catch { return false; }
  }

  async getFriends(): Promise<PeerId[]> {
    const friends: PeerId[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.FRIEND, lt: NS.FRIEND + '\xFF' })) {
      const data = JSON.parse(value);
      friends.push(data.peerId);
    }
    return friends;
  }

  // ─── Block List ────────────────────────────────────────────────────────

  async blockPeer(peerId: PeerId): Promise<void> {
    await this.db.put(NS.BLOCK + peerId, JSON.stringify({ peerId, blockedAt: Date.now() }));
  }

  async unblockPeer(peerId: PeerId): Promise<void> {
    try { await this.db.del(NS.BLOCK + peerId); } catch {}
  }

  async isBlocked(peerId: PeerId): Promise<boolean> {
    try { await this.db.get(NS.BLOCK + peerId); return true; } catch { return false; }
  }

  async getBlockedPeers(): Promise<PeerId[]> {
    const blocked: PeerId[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.BLOCK, lt: NS.BLOCK + '\xFF' })) {
      const data = JSON.parse(value);
      blocked.push(data.peerId);
    }
    return blocked;
  }

  // ─── Posts, Reactions, Comments (Phase 4) ──────────────────────────────

  async storePost(post: Post): Promise<void> {
    await this.db.put(NS.POST + post.postId, JSON.stringify(post));
    // Timestamp index for chronological feed
    const tsKey = post.timestamp.toString().padStart(15, '0');
    await this.db.put(NS.POST_IDX + tsKey + ':' + post.postId, post.postId);
  }

  async getPost(postId: string): Promise<Post | null> {
    try {
      return JSON.parse(await this.db.get(NS.POST + postId));
    } catch {
      return null;
    }
  }

  async getTimeline(limit: number = 50, before?: number): Promise<Post[]> {
    const posts: Post[] = [];
    const lt = before
      ? NS.POST_IDX + before.toString().padStart(15, '0') + ':'
      : NS.POST_IDX + '\xFF';

    for await (const [, postId] of this.db.iterator({ gte: NS.POST_IDX, lt, reverse: true, limit })) {
      try {
        const post = JSON.parse(await this.db.get(NS.POST + postId));
        posts.push(post);
      } catch {}
    }
    return posts;
  }

  /** Get posts since a timestamp (for feed sync) */
  async getPostsSince(since: number, limit: number = 200): Promise<Post[]> {
    const posts: Post[] = [];
    const gte = NS.POST_IDX + since.toString().padStart(15, '0');
    for await (const [, postId] of this.db.iterator({ gte, lt: NS.POST_IDX + '\xFF', limit })) {
      try {
        const post = JSON.parse(await this.db.get(NS.POST + postId));
        posts.push(post);
      } catch {}
    }
    return posts;
  }

  /** Get post IDs since a timestamp (lightweight, for sync digest) */
  async getPostIds(since: number): Promise<string[]> {
    const ids: string[] = [];
    const gte = NS.POST_IDX + since.toString().padStart(15, '0');
    for await (const [, postId] of this.db.iterator({ gte, lt: NS.POST_IDX + '\xFF' })) {
      ids.push(postId);
    }
    return ids;
  }

  /** Get the timestamp of the most recent post */
  async getLatestPostTimestamp(): Promise<number> {
    for await (const [key] of this.db.iterator({ gte: NS.POST_IDX, lt: NS.POST_IDX + '\xFF', reverse: true, limit: 1 })) {
      const tsStr = key.slice(NS.POST_IDX.length).split(':')[0];
      return parseInt(tsStr, 10) || 0;
    }
    return 0;
  }

  /** Delete posts older than maxAgeDays and their reactions/comments */
  async cleanOldPosts(maxAgeDays: number): Promise<number> {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const cutoffKey = NS.POST_IDX + cutoff.toString().padStart(15, '0');
    const toDelete: string[] = [];

    for await (const [, postId] of this.db.iterator({ gte: NS.POST_IDX, lt: cutoffKey })) {
      toDelete.push(postId);
    }

    for (const postId of toDelete) {
      await this.deletePost(postId);
    }

    return toDelete.length;
  }

  async deletePost(postId: string): Promise<void> {
    // Delete post record
    try { await this.db.del(NS.POST + postId); } catch {}
    // Delete timestamp index entries
    for await (const [key, value] of this.db.iterator({ gte: NS.POST_IDX, lt: NS.POST_IDX + '\xFF' })) {
      if (value === postId) { await this.db.del(key); break; }
    }
    // Delete all reactions for this post
    const reactionPrefix = NS.REACTION + postId + ':';
    for await (const key of this.db.keys({ gte: reactionPrefix, lt: reactionPrefix + '\xFF' })) {
      await this.db.del(key);
    }
    // Delete all comments for this post
    const commentPrefix = NS.COMMENT + postId + ':';
    for await (const key of this.db.keys({ gte: commentPrefix, lt: commentPrefix + '\xFF' })) {
      await this.db.del(key);
    }
  }

  async deleteHistoryMessage(conversationId: string, timestamp: number, messageId: string): Promise<void> {
    const tsKey = timestamp.toString().padStart(15, '0');
    const key = NS.HISTORY + conversationId + ':' + tsKey + ':' + messageId;
    try { await this.db.del(key); } catch {}
  }

  async getPostsByAuthor(authorId: PeerId, limit: number = 50): Promise<Post[]> {
    const posts: Post[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.POST, lt: NS.POST + '\xFF' })) {
      const post = JSON.parse(value) as Post;
      if (post.authorId === authorId) posts.push(post);
    }
    return posts.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async getPostCount(authorId?: PeerId): Promise<number> {
    let count = 0;
    for await (const [, value] of this.db.iterator({ gte: NS.POST, lt: NS.POST + '\xFF' })) {
      if (authorId) {
        const post = JSON.parse(value) as Post;
        if (post.authorId === authorId) count++;
      } else {
        count++;
      }
    }
    return count;
  }

  async storeReaction(reaction: PostReaction): Promise<void> {
    await this.db.put(NS.REACTION + reaction.postId + ':' + reaction.authorId, JSON.stringify(reaction));
  }

  async getReaction(postId: string, authorId: PeerId): Promise<PostReaction | null> {
    try {
      return JSON.parse(await this.db.get(NS.REACTION + postId + ':' + authorId));
    } catch {
      return null;
    }
  }

  async deleteReaction(postId: string, authorId: PeerId): Promise<void> {
    try { await this.db.del(NS.REACTION + postId + ':' + authorId); } catch {}
  }

  async storeComment(comment: PostComment): Promise<void> {
    const tsKey = comment.timestamp.toString().padStart(15, '0');
    await this.db.put(NS.COMMENT + comment.postId + ':' + tsKey + ':' + comment.commentId, JSON.stringify(comment));
  }

  async getPostComments(postId: string): Promise<PostComment[]> {
    const prefix = NS.COMMENT + postId + ':';
    const comments: PostComment[] = [];
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      comments.push(JSON.parse(value));
    }
    return comments;
  }

  // ─── Vouch Storage (Trust Web) ──────────────────────────────────────────

  async storeVouch(vouch: Vouch): Promise<void> {
    await this.db.put(NS.VOUCH + vouch.vouchId, JSON.stringify(vouch));
    await this.db.put(NS.VOUCH_IDX + vouch.fromId + ':' + vouch.toId, vouch.vouchId);
  }

  async getVouch(vouchId: string): Promise<Vouch | null> {
    try {
      return JSON.parse(await this.db.get(NS.VOUCH + vouchId));
    } catch {
      return null;
    }
  }

  async getVouchByPair(fromId: PeerId, toId: PeerId): Promise<Vouch | null> {
    try {
      const vouchId = await this.db.get(NS.VOUCH_IDX + fromId + ':' + toId);
      return this.getVouch(vouchId);
    } catch {
      return null;
    }
  }

  async revokeVouch(revocation: VouchRevocation): Promise<void> {
    await this.db.put(NS.VOUCH_REV + revocation.vouchId, JSON.stringify(revocation));
    // Delete the vouch and its index
    const vouch = await this.getVouch(revocation.vouchId);
    if (vouch) {
      try { await this.db.del(NS.VOUCH + revocation.vouchId); } catch {}
      try { await this.db.del(NS.VOUCH_IDX + vouch.fromId + ':' + vouch.toId); } catch {}
    }
  }

  async isRevoked(vouchId: string): Promise<boolean> {
    try {
      await this.db.get(NS.VOUCH_REV + vouchId);
      return true;
    } catch {
      return false;
    }
  }

  async getVouchesFrom(peerId: PeerId): Promise<Vouch[]> {
    const vouches: Vouch[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.VOUCH, lt: NS.VOUCH + '\xFF' })) {
      const vouch = JSON.parse(value) as Vouch;
      if (vouch.fromId === peerId) vouches.push(vouch);
    }
    return vouches;
  }

  async getVouchesFor(peerId: PeerId): Promise<Vouch[]> {
    const vouches: Vouch[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.VOUCH, lt: NS.VOUCH + '\xFF' })) {
      const vouch = JSON.parse(value) as Vouch;
      if (vouch.toId === peerId) vouches.push(vouch);
    }
    return vouches;
  }

  /** Get all vouches (for sync) */
  async getAllVouches(): Promise<Vouch[]> {
    const vouches: Vouch[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.VOUCH, lt: NS.VOUCH + '\xFF' })) {
      vouches.push(JSON.parse(value) as Vouch);
    }
    return vouches;
  }

  /** Get all vouch IDs (for sync digest) */
  async getAllVouchIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.VOUCH, lt: NS.VOUCH + '\xFF' })) {
      const vouch = JSON.parse(value) as Vouch;
      ids.push(vouch.vouchId);
    }
    return ids;
  }

  /** Get all revocation IDs (for sync) */
  async getAllRevocationIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const [key] of this.db.iterator({ gte: NS.VOUCH_REV, lt: NS.VOUCH_REV + '\xFF' })) {
      ids.push(key.slice(NS.VOUCH_REV.length));
    }
    return ids;
  }

  async getVouchCount(peerId: PeerId): Promise<{ given: number; received: number }> {
    let given = 0;
    let received = 0;
    for await (const [, value] of this.db.iterator({ gte: NS.VOUCH, lt: NS.VOUCH + '\xFF' })) {
      const vouch = JSON.parse(value) as Vouch;
      if (vouch.fromId === peerId) given++;
      if (vouch.toId === peerId) received++;
    }
    return { given, received };
  }

  // ─── Dead Drops ──────────────────────────────────────────────────────────

  async storeDeadDrop(drop: DeadDrop): Promise<void> {
    await this.db.put(NS.DEAD_DROP + drop.dropId, JSON.stringify(drop));
    const tsKey = drop.timestamp.toString().padStart(15, '0');
    await this.db.put(NS.DEAD_DROP_IDX + tsKey + ':' + drop.dropId, drop.dropId);
  }

  async getDeadDrop(dropId: string): Promise<DeadDrop | null> {
    try {
      return JSON.parse(await this.db.get(NS.DEAD_DROP + dropId));
    } catch {
      return null;
    }
  }

  async getDeadDropFeed(limit: number = 50): Promise<DeadDrop[]> {
    const drops: DeadDrop[] = [];
    const now = Date.now();
    for await (const [, dropId] of this.db.iterator({ gte: NS.DEAD_DROP_IDX, lt: NS.DEAD_DROP_IDX + '\xFF', reverse: true, limit: limit * 2 })) {
      try {
        const drop: DeadDrop = JSON.parse(await this.db.get(NS.DEAD_DROP + dropId));
        if (drop.expiresAt > now) {
          drops.push(drop);
          if (drops.length >= limit) break;
        }
      } catch {}
    }
    return drops;
  }

  async updateDropVotes(dropId: string, votes: number): Promise<void> {
    const drop = await this.getDeadDrop(dropId);
    if (drop) {
      drop.votes = votes;
      await this.db.put(NS.DEAD_DROP + dropId, JSON.stringify(drop));
    }
  }

  async hasVotedOnDrop(dropId: string): Promise<boolean> {
    const prefix = NS.DEAD_DROP_VOTE + dropId + ':';
    for await (const _ of this.db.keys({ gte: prefix, lt: prefix + '\xFF', limit: 1 })) {
      return true;
    }
    return false;
  }

  async recordDropVote(vote: DeadDropVote): Promise<void> {
    await this.db.put(NS.DEAD_DROP_VOTE + vote.dropId + ':' + vote.voteId, JSON.stringify(vote));
  }

  async cleanExpiredDrops(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    for await (const [key, dropId] of this.db.iterator({ gte: NS.DEAD_DROP_IDX, lt: NS.DEAD_DROP_IDX + '\xFF' })) {
      try {
        const drop: DeadDrop = JSON.parse(await this.db.get(NS.DEAD_DROP + dropId));
        if (drop.expiresAt < now) {
          await this.db.del(NS.DEAD_DROP + dropId);
          await this.db.del(key);
          // Clean associated votes
          const votePrefix = NS.DEAD_DROP_VOTE + dropId + ':';
          for await (const voteKey of this.db.keys({ gte: votePrefix, lt: votePrefix + '\xFF' })) {
            await this.db.del(voteKey);
          }
          cleaned++;
        }
      } catch {}
    }
    return cleaned;
  }

  // ─── Encrypted Polls ──────────────────────────────────────────────────

  async storePoll(poll: Poll): Promise<void> {
    await this.db.put(NS.POLL + poll.pollId, JSON.stringify(poll));
    const tsKey = poll.createdAt.toString().padStart(15, '0');
    await this.db.put(NS.POLL_IDX + tsKey + ':' + poll.pollId, poll.pollId);
  }

  async getPoll(pollId: string): Promise<Poll | null> {
    try {
      return JSON.parse(await this.db.get(NS.POLL + pollId));
    } catch {
      return null;
    }
  }

  async getPolls(limit: number = 50, scope?: string, groupId?: string): Promise<Poll[]> {
    const polls: Poll[] = [];
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000; // hide closed polls older than 7 days
    for await (const [, pollId] of this.db.iterator({ gte: NS.POLL_IDX, lt: NS.POLL_IDX + '\xFF', reverse: true, limit: limit * 3 })) {
      try {
        const poll: Poll = JSON.parse(await this.db.get(NS.POLL + pollId));
        if (poll.status === 'closed' && poll.expiresAt < cutoff) continue;
        if (scope && poll.scope !== scope) continue;
        if (groupId && poll.groupId !== groupId) continue;
        polls.push(poll);
        if (polls.length >= limit) break;
      } catch {}
    }
    return polls;
  }

  async storeEncryptedVote(vote: EncryptedVote): Promise<void> {
    await this.db.put(NS.POLL_VOTE + vote.pollId + ':' + vote.voterId, JSON.stringify(vote));
  }

  async hasVoteFrom(pollId: string, voterId: string): Promise<boolean> {
    try {
      await this.db.get(NS.POLL_VOTE + pollId + ':' + voterId);
      return true;
    } catch {
      return false;
    }
  }

  async getVotesForPoll(pollId: string): Promise<EncryptedVote[]> {
    const votes: EncryptedVote[] = [];
    const prefix = NS.POLL_VOTE + pollId + ':';
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      votes.push(JSON.parse(value));
    }
    return votes;
  }

  async storeVoteReceipt(receipt: PollVoteReceipt): Promise<void> {
    await this.db.put(NS.POLL_RECEIPT + receipt.pollId, JSON.stringify(receipt));
  }

  async getVoteReceipt(pollId: string): Promise<PollVoteReceipt | null> {
    try {
      return JSON.parse(await this.db.get(NS.POLL_RECEIPT + pollId));
    } catch {
      return null;
    }
  }

  async storePollResults(results: PollResults): Promise<void> {
    await this.db.put(NS.POLL_RESULTS + results.pollId, JSON.stringify(results));
  }

  async getPollResults(pollId: string): Promise<PollResults | null> {
    try {
      return JSON.parse(await this.db.get(NS.POLL_RESULTS + pollId));
    } catch {
      return null;
    }
  }

  async closeExpiredPolls(): Promise<number> {
    const now = Date.now();
    let closed = 0;
    for await (const [, value] of this.db.iterator({ gte: NS.POLL, lt: NS.POLL + '\xFF' })) {
      const poll: Poll = JSON.parse(value);
      if (poll.status === 'open' && poll.expiresAt < now) {
        poll.status = 'closed';
        await this.db.put(NS.POLL + poll.pollId, JSON.stringify(poll));
        closed++;
      }
    }
    return closed;
  }

  // ─── Hubs ─────────────────────────────────────────────────────────────

  async storeHub(hub: Hub): Promise<void> {
    await this.db.put(NS.HUB + hub.hubId, JSON.stringify(hub));
  }

  async getHub(hubId: string): Promise<Hub | null> {
    try {
      return JSON.parse(await this.db.get(NS.HUB + hubId));
    } catch {
      return null;
    }
  }

  async getAllHubs(): Promise<Hub[]> {
    const hubs: Hub[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HUB, lt: NS.HUB + '\xFF' })) {
      hubs.push(JSON.parse(value));
    }
    return hubs;
  }

  async deleteHub(hubId: string): Promise<void> {
    try { await this.db.del(NS.HUB + hubId); } catch {}
    // Clean categories, channels, members, invites
    for await (const key of this.db.keys({ gte: NS.HUB_CATEGORY + hubId + ':', lt: NS.HUB_CATEGORY + hubId + ':\xFF' })) {
      await this.db.del(key);
    }
    for await (const key of this.db.keys({ gte: NS.HUB_CHANNEL + hubId + ':', lt: NS.HUB_CHANNEL + hubId + ':\xFF' })) {
      await this.db.del(key);
    }
    for await (const key of this.db.keys({ gte: NS.HUB_MEMBER + hubId + ':', lt: NS.HUB_MEMBER + hubId + ':\xFF' })) {
      await this.db.del(key);
    }
  }

  // ─── Hub Categories ──────────────────────────────────────────────────

  async storeHubCategory(cat: HubCategory): Promise<void> {
    await this.db.put(NS.HUB_CATEGORY + cat.hubId + ':' + cat.categoryId, JSON.stringify(cat));
  }

  async getHubCategories(hubId: string): Promise<HubCategory[]> {
    const cats: HubCategory[] = [];
    const prefix = NS.HUB_CATEGORY + hubId + ':';
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      cats.push(JSON.parse(value));
    }
    return cats.sort((a, b) => a.position - b.position);
  }

  async deleteHubCategory(hubId: string, categoryId: string): Promise<void> {
    try { await this.db.del(NS.HUB_CATEGORY + hubId + ':' + categoryId); } catch {}
  }

  // ─── Hub Channels ────────────────────────────────────────────────────

  async storeHubChannel(ch: HubChannel): Promise<void> {
    await this.db.put(NS.HUB_CHANNEL + ch.hubId + ':' + ch.channelId, JSON.stringify(ch));
  }

  async getHubChannels(hubId: string): Promise<HubChannel[]> {
    const channels: HubChannel[] = [];
    const prefix = NS.HUB_CHANNEL + hubId + ':';
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      channels.push(JSON.parse(value));
    }
    return channels.sort((a, b) => a.position - b.position);
  }

  async getHubChannelsByCategory(hubId: string, categoryId: string): Promise<HubChannel[]> {
    const all = await this.getHubChannels(hubId);
    return all.filter(ch => ch.categoryId === categoryId);
  }

  async deleteHubChannel(hubId: string, channelId: string): Promise<void> {
    try { await this.db.del(NS.HUB_CHANNEL + hubId + ':' + channelId); } catch {}
  }

  // ─── Hub Members ─────────────────────────────────────────────────────

  async storeHubMember(member: HubMember): Promise<void> {
    await this.db.put(NS.HUB_MEMBER + member.hubId + ':' + member.peerId, JSON.stringify(member));
  }

  async getHubMember(hubId: string, peerId: PeerId): Promise<HubMember | null> {
    try {
      return JSON.parse(await this.db.get(NS.HUB_MEMBER + hubId + ':' + peerId));
    } catch {
      return null;
    }
  }

  async getHubMembers(hubId: string): Promise<HubMember[]> {
    const members: HubMember[] = [];
    const prefix = NS.HUB_MEMBER + hubId + ':';
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      members.push(JSON.parse(value));
    }
    return members;
  }

  async removeHubMember(hubId: string, peerId: PeerId): Promise<void> {
    try { await this.db.del(NS.HUB_MEMBER + hubId + ':' + peerId); } catch {}
  }

  // ─── Hub Invites ─────────────────────────────────────────────────────

  async storeHubInvite(invite: HubInvite): Promise<void> {
    await this.db.put(NS.HUB_INVITE + invite.inviteId, JSON.stringify(invite));
  }

  async getHubInvite(inviteId: string): Promise<HubInvite | null> {
    try {
      return JSON.parse(await this.db.get(NS.HUB_INVITE + inviteId));
    } catch {
      return null;
    }
  }

  async getHubInvites(hubId: string): Promise<HubInvite[]> {
    const invites: HubInvite[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HUB_INVITE, lt: NS.HUB_INVITE + '\xFF' })) {
      const inv = JSON.parse(value) as HubInvite;
      if (inv.hubId === hubId) invites.push(inv);
    }
    return invites;
  }

  async deleteHubInvite(inviteId: string): Promise<void> {
    try { await this.db.del(NS.HUB_INVITE + inviteId); } catch {}
  }

  // ─── Hub Discovery ───────────────────────────────────────────────────

  async storeHubListing(listing: HubListing): Promise<void> {
    await this.db.put(NS.HUB_LISTING + listing.hubId, JSON.stringify(listing));
  }

  async getHubListing(hubId: string): Promise<HubListing | null> {
    try {
      return JSON.parse(await this.db.get(NS.HUB_LISTING + hubId));
    } catch {
      return null;
    }
  }

  async getPublicHubListings(limit: number = 50): Promise<HubListing[]> {
    const listings: HubListing[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HUB_LISTING, lt: NS.HUB_LISTING + '\xFF' })) {
      const listing = JSON.parse(value) as HubListing;
      if (listing.isPublic) listings.push(listing);
    }
    return listings
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, limit);
  }

  async searchHubListings(searchTerm: string, tags?: string[], limit: number = 50): Promise<HubListing[]> {
    const term = searchTerm.toLowerCase();
    const listings: HubListing[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HUB_LISTING, lt: NS.HUB_LISTING + '\xFF' })) {
      const listing = JSON.parse(value) as HubListing;
      if (!listing.isPublic) continue;
      const nameMatch = listing.name.toLowerCase().includes(term);
      const descMatch = listing.description.toLowerCase().includes(term);
      const tagMatch = tags && tags.length > 0 ? listing.tags.some(t => tags.includes(t)) : false;
      if (nameMatch || descMatch || tagMatch || !term) {
        listings.push(listing);
      }
    }
    return listings
      .sort((a, b) => b.memberCount - a.memberCount)
      .slice(0, limit);
  }

  // ─── Hub Stats ─────────────────────────────────────────────────────────

  async storeHubStats(stats: HubStats): Promise<void> {
    await this.db.put(NS.HUB_STATS + stats.hubId, JSON.stringify(stats));
  }

  async getHubStats(hubId: string): Promise<HubStats | null> {
    try {
      return JSON.parse(await this.db.get(NS.HUB_STATS + hubId)) as HubStats;
    } catch { return null; }
  }

  async getAllHubStats(): Promise<HubStats[]> {
    const results: HubStats[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HUB_STATS, lt: NS.HUB_STATS + '\xFF' })) {
      results.push(JSON.parse(value) as HubStats);
    }
    return results;
  }

  async countHubMessages(hubId: string, channelIds: string[], since: number): Promise<number> {
    let count = 0;
    for (const chId of channelIds) {
      const prefix = NS.HISTORY + 'hub:' + hubId + ':' + chId + ':';
      const sinceKey = prefix + since.toString().padStart(15, '0');
      for await (const [,] of this.db.iterator({ gte: sinceKey, lt: prefix + '\xFF' })) {
        count++;
      }
    }
    return count;
  }

  async countHubMessagesByMember(hubId: string, channelIds: string[], since: number): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const chId of channelIds) {
      const prefix = NS.HISTORY + 'hub:' + hubId + ':' + chId + ':';
      const sinceKey = prefix + since.toString().padStart(15, '0');
      for await (const [, value] of this.db.iterator({ gte: sinceKey, lt: prefix + '\xFF' })) {
        const msg = JSON.parse(value) as StoredMessage;
        counts.set(msg.from, (counts.get(msg.from) || 0) + 1);
      }
    }
    return counts;
  }

  async countHubDailyMessages(hubId: string, channelIds: string[], days: number = 7): Promise<number[]> {
    const now = Date.now();
    const dayMs = 86400000;
    const buckets = new Array(days).fill(0);
    const startTime = now - days * dayMs;
    for (const chId of channelIds) {
      const prefix = NS.HISTORY + 'hub:' + hubId + ':' + chId + ':';
      const sinceKey = prefix + startTime.toString().padStart(15, '0');
      for await (const [, value] of this.db.iterator({ gte: sinceKey, lt: prefix + '\xFF' })) {
        const msg = JSON.parse(value) as StoredMessage;
        const dayIndex = Math.floor((msg.timestamp - startTime) / dayMs);
        if (dayIndex >= 0 && dayIndex < days) buckets[dayIndex]++;
      }
    }
    return buckets;
  }

  // ─── Hub Stats Snapshots ────────────────────────────────────────────────

  async storeHubStatsSnapshot(hubId: string, stats: HubStats): Promise<void> {
    const tsKey = stats.computedAt.toString().padStart(15, '0');
    await this.db.put(NS.HUB_STATS_SNAP + hubId + ':' + tsKey, JSON.stringify(stats));
  }

  async getHubStatsHistory(hubId: string, since?: number): Promise<HubStats[]> {
    const prefix = NS.HUB_STATS_SNAP + hubId + ':';
    const gte = since
      ? prefix + since.toString().padStart(15, '0')
      : prefix;
    const snapshots: HubStats[] = [];
    for await (const [, value] of this.db.iterator({ gte, lt: prefix + '\xFF' })) {
      snapshots.push(JSON.parse(value));
    }
    return snapshots;
  }

  // ─── Content Reports ──────────────────────────────────────────────────

  async storeReport(report: { id: string; contentType: string; contentId: string; reporterId: string; reason: string; detail?: string; timestamp: number }): Promise<void> {
    await this.db.put(NS.REPORT + report.contentId + ':' + report.reporterId, JSON.stringify(report));
  }

  async getReportsForContent(contentId: string): Promise<any[]> {
    const prefix = NS.REPORT + contentId + ':';
    const reports: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
      reports.push(JSON.parse(value));
    }
    return reports;
  }

  async getReportCount(contentId: string): Promise<number> {
    let count = 0;
    const prefix = NS.REPORT + contentId + ':';
    for await (const _ of this.db.keys({ gte: prefix, lt: prefix + '\xFF' })) {
      count++;
    }
    return count;
  }

  async isContentHidden(contentId: string): Promise<boolean> {
    return (await this.getReportCount(contentId)) >= 3;
  }

  // ─── Dead Man's Switch ──────────────────────────────────────────────

  async storeDMS(dms: DeadManSwitch): Promise<void> {
    await this.db.put(NS.DMS + dms.switchId, JSON.stringify(dms));
  }

  async getDMS(switchId: string): Promise<DeadManSwitch | null> {
    try {
      return JSON.parse(await this.db.get(NS.DMS + switchId));
    } catch {
      return null;
    }
  }

  async getAllArmedDMS(): Promise<DeadManSwitch[]> {
    const switches: DeadManSwitch[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.DMS, lt: NS.DMS + '\xFF' })) {
      const dms = JSON.parse(value) as DeadManSwitch;
      if (dms.status === 'armed') switches.push(dms);
    }
    return switches;
  }

  async getAllDMS(): Promise<DeadManSwitch[]> {
    const switches: DeadManSwitch[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.DMS, lt: NS.DMS + '\xFF' })) {
      switches.push(JSON.parse(value));
    }
    return switches;
  }

  async updateDMS(dms: DeadManSwitch): Promise<void> {
    await this.db.put(NS.DMS + dms.switchId, JSON.stringify(dms));
  }

  async deleteDMS(switchId: string): Promise<void> {
    try { await this.db.del(NS.DMS + switchId); } catch {}
  }

  // ─── Data Export ──────────────────────────────────────────────────────

  async exportAllData(peerId: string): Promise<object> {
    const conversations: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HISTORY, lt: NS.HISTORY + '\xFF' })) {
      conversations.push(JSON.parse(value));
    }

    const messages: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.MESSAGE, lt: NS.MESSAGE + '\xFF' })) {
      messages.push(JSON.parse(value));
    }

    const posts: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.POST, lt: NS.POST + '\xFF' })) {
      posts.push(JSON.parse(value));
    }

    const contacts: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.PEER, lt: NS.PEER + '\xFF' })) {
      const parsed = JSON.parse(value);
      contacts.push({ peerId: parsed.peerId, displayName: parsed.displayName, lastSeen: parsed.lastSeen });
    }

    const groups: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.GROUP, lt: NS.GROUP + '\xFF' })) {
      const g = JSON.parse(value);
      groups.push({ groupId: g.groupId, name: g.name, members: g.members, createdAt: g.createdAt });
    }

    const hubs: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.HUB, lt: NS.HUB + '\xFF' })) {
      const h = JSON.parse(value);
      hubs.push({ hubId: h.hubId, name: h.name, description: h.description, createdAt: h.createdAt });
    }

    const pinnedKeys: any[] = [];
    for await (const [, value] of this.db.iterator({ gte: NS.TOFU, lt: NS.TOFU + '\xFF' })) {
      pinnedKeys.push(JSON.parse(value));
    }

    let displayName: string | undefined;
    try { displayName = (await this.db.get(NS.META + 'displayName')) || undefined; } catch {}

    let themePrefs: any;
    try { const tp = await this.db.get(NS.META + 'themePrefs'); if (tp) themePrefs = JSON.parse(tp); } catch {}

    return {
      exportDate: new Date().toISOString(),
      peerId,
      settings: { displayName, themePrefs },
      conversations,
      messages,
      posts,
      contacts,
      groups,
      hubs,
      pinnedKeys,
    };
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  getStorageUsage(): { used: number; max: number; percentage: number } {
    return {
      used: this.currentStorageBytes,
      max: this.maxStorageBytes,
      percentage: (this.currentStorageBytes / this.maxStorageBytes) * 100,
    };
  }

  /** Update the storage limit (e.g. when Pro license is activated) */
  setMaxStorageBytes(maxBytes: number): void {
    this.maxStorageBytes = maxBytes;
    console.log(`[Store] Storage limit updated to ${formatBytes(maxBytes)}`);
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
