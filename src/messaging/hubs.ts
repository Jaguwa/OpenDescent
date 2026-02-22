/**
 * Hub Manager — Community spaces for DecentraNet
 *
 * Hubs extend the existing group chat model with:
 * - Categories and channels (text + voice)
 * - 3-tier roles (Owner / Admin / Member)
 * - Public hub discovery via gossip
 * - Invite codes
 * - Group key rotation on member removal
 *
 * Encryption: Single shared AES-256 key per hub (same as GroupManager).
 * Roles control who can send/manage, not who can read.
 */

import * as crypto from 'crypto';
import type {
  PeerId,
  Identity,
  Message,
  ContentType,
  Hub,
  HubCategory,
  HubChannel,
  HubMember,
  HubInvite,
  HubListing,
  HubRoleType,
  HubChannelType,
  HubStats,
  HUB_ROLE_PERMISSIONS,
} from '../types/index.js';
import {
  encryptForPeer,
  decryptFromPeer,
  encryptWithGroupKey,
  decryptWithGroupKey,
  generateGroupKey,
} from '../crypto/encryption.js';
import { sign, publicKeyToPeerId } from '../crypto/identity.js';
import { DecentraNode, PROTOCOLS } from '../network/node.js';
import { LocalStore, type StoredMessage } from '../storage/store.js';

// Re-import the permissions constant for runtime use
const ROLE_PERMISSIONS: Record<HubRoleType, { manageHub: boolean; manageChannels: boolean; manageMembers: boolean; sendMessages: boolean; joinVoice: boolean }> = {
  owner:  { manageHub: true,  manageChannels: true,  manageMembers: true,  sendMessages: true,  joinVoice: true },
  admin:  { manageHub: false, manageChannels: true,  manageMembers: true,  sendMessages: true,  joinVoice: true },
  member: { manageHub: false, manageChannels: false, manageMembers: false, sendMessages: true,  joinVoice: true },
};

/** Hub sync message types sent over HUB_SYNC protocol */
interface HubSyncMessage {
  type: 'hub_invite' | 'hub_join_accept' | 'hub_key_update' | 'hub_channel_message' |
        'hub_update' | 'hub_member_update' | 'hub_leave';
  hubId: string;
  from: PeerId;
  payload: unknown;
  timestamp: number;
}

/** Hub discovery message types */
interface HubDiscoveryMessage {
  type: 'hub_listing' | 'hub_search' | 'hub_search_results';
  payload: unknown;
  from: PeerId;
  timestamp: number;
}

export class HubManager {
  private node: DecentraNode;
  private store: LocalStore;
  private identity: Identity;
  private hubs: Map<string, Hub> = new Map();

  // Callbacks
  onChannelMessage: Array<(hubId: string, channelId: string, message: StoredMessage) => void> = [];
  onHubUpdate: Array<(hubId: string, update: any) => void> = [];
  onHubJoined: Array<(hub: Hub) => void> = [];
  onMemberJoined: Array<(hubId: string, member: HubMember) => void> = [];
  onMemberLeft: Array<(hubId: string, peerId: PeerId) => void> = [];
  onInviteReceived: Array<(hubId: string, hubName: string, from: PeerId) => void> = [];

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;
    this.identity = node.getIdentity();
  }

  // ─── Hub Lifecycle ──────────────────────────────────────────────────────

  async loadHubs(): Promise<void> {
    const hubs = await this.store.getAllHubs();
    for (const hub of hubs) {
      this.hubs.set(hub.hubId, hub);
    }
    if (hubs.length > 0) {
      console.log(`[Hubs] Loaded ${hubs.length} hub(s)`);
    }
    await this.migrateGroupsToHubs();
  }

  async createHub(
    name: string,
    description: string,
    isPublic: boolean,
    tags: string[] = [],
    icon?: string,
  ): Promise<string> {
    const hubId = crypto.randomUUID();
    const hubKey = generateGroupKey();
    const myId = this.node.getPeerId();

    const hub: Hub = {
      hubId,
      name,
      description,
      icon,
      ownerId: myId,
      hubKey: Buffer.from(hubKey).toString('base64'),
      isPublic,
      tags,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      version: 1,
      signature: '',
    };

    // Sign the hub
    hub.signature = this.signHub(hub);

    this.hubs.set(hubId, hub);
    await this.store.storeHub(hub);

    // Create default categories and channels
    const textCatId = crypto.randomUUID();
    const voiceCatId = crypto.randomUUID();

    await this.store.storeHubCategory({ categoryId: textCatId, hubId, name: 'TEXT CHANNELS', position: 0 });
    await this.store.storeHubCategory({ categoryId: voiceCatId, hubId, name: 'VOICE', position: 1 });

    const generalId = crypto.randomUUID();
    await this.store.storeHubChannel({
      channelId: generalId, hubId, categoryId: textCatId,
      name: 'general', type: 'text', position: 0,
    });

    const voiceGeneralId = crypto.randomUUID();
    await this.store.storeHubChannel({
      channelId: voiceGeneralId, hubId, categoryId: voiceCatId,
      name: 'General Voice', type: 'voice', position: 0,
    });

    // Add self as owner
    await this.store.storeHubMember({
      peerId: myId, hubId, role: 'owner',
      joinedAt: Date.now(),
      displayName: this.identity.displayName,
    });

    // Announce to network if public
    if (isPublic) {
      await this.announceHub(hubId);
    }

    console.log(`[Hubs] Created hub "${name}" (${hubId})`);
    return hubId;
  }

  async updateHub(hubId: string, updates: Partial<Pick<Hub, 'name' | 'description' | 'icon' | 'isPublic' | 'tags'>>): Promise<void> {
    const hub = this.hubs.get(hubId);
    if (!hub) throw new Error(`Unknown hub: ${hubId}`);

    const myRole = await this.getMyRole(hubId);
    if (myRole !== 'owner') throw new Error('Only the owner can update the hub');

    Object.assign(hub, updates);
    hub.version++;
    hub.lastActivityAt = Date.now();
    hub.signature = this.signHub(hub);

    this.hubs.set(hubId, hub);
    await this.store.storeHub(hub);

    // Notify all members
    await this.broadcastToHubMembers(hubId, {
      type: 'hub_update',
      hubId,
      from: this.node.getPeerId(),
      payload: { hub },
      timestamp: Date.now(),
    });

    for (const cb of this.onHubUpdate) cb(hubId, { type: 'hub_updated', hub });
  }

  async deleteHub(hubId: string): Promise<void> {
    const hub = this.hubs.get(hubId);
    if (!hub) return;

    const myRole = await this.getMyRole(hubId);
    if (myRole !== 'owner') throw new Error('Only the owner can delete the hub');

    // Notify members
    await this.broadcastToHubMembers(hubId, {
      type: 'hub_update',
      hubId,
      from: this.node.getPeerId(),
      payload: { action: 'deleted' },
      timestamp: Date.now(),
    });

    this.hubs.delete(hubId);
    await this.store.deleteHub(hubId);
    console.log(`[Hubs] Deleted hub "${hub.name}"`);
  }

  async leaveHub(hubId: string): Promise<void> {
    const hub = this.hubs.get(hubId);
    if (!hub) return;

    const myId = this.node.getPeerId();

    // Notify members
    await this.broadcastToHubMembers(hubId, {
      type: 'hub_leave',
      hubId,
      from: myId,
      payload: {},
      timestamp: Date.now(),
    });

    await this.store.removeHubMember(hubId, myId);
    this.hubs.delete(hubId);
    await this.store.deleteHub(hubId);

    console.log(`[Hubs] Left hub "${hub.name}"`);
  }

  // ─── Category/Channel CRUD ──────────────────────────────────────────────

  async createCategory(hubId: string, name: string): Promise<string> {
    await this.requirePermission(hubId, 'manageChannels');
    const cats = await this.store.getHubCategories(hubId);
    const categoryId = crypto.randomUUID();
    await this.store.storeHubCategory({
      categoryId, hubId, name,
      position: cats.length,
    });
    await this.syncStructureUpdate(hubId);
    return categoryId;
  }

  async renameCategory(hubId: string, categoryId: string, name: string): Promise<void> {
    await this.requirePermission(hubId, 'manageChannels');
    const cats = await this.store.getHubCategories(hubId);
    const cat = cats.find(c => c.categoryId === categoryId);
    if (!cat) throw new Error('Category not found');
    cat.name = name;
    await this.store.storeHubCategory(cat);
    await this.syncStructureUpdate(hubId);
  }

  async deleteCategory(hubId: string, categoryId: string): Promise<void> {
    await this.requirePermission(hubId, 'manageChannels');
    // Delete channels in this category
    const channels = await this.store.getHubChannelsByCategory(hubId, categoryId);
    for (const ch of channels) {
      await this.store.deleteHubChannel(hubId, ch.channelId);
    }
    await this.store.deleteHubCategory(hubId, categoryId);
    await this.syncStructureUpdate(hubId);
  }

  async createChannel(hubId: string, categoryId: string, name: string, type: HubChannelType = 'text'): Promise<string> {
    await this.requirePermission(hubId, 'manageChannels');
    const channels = await this.store.getHubChannelsByCategory(hubId, categoryId);
    const channelId = crypto.randomUUID();
    await this.store.storeHubChannel({
      channelId, hubId, categoryId, name, type,
      position: channels.length,
    });
    await this.syncStructureUpdate(hubId);
    return channelId;
  }

  async updateChannel(hubId: string, channelId: string, updates: Partial<Pick<HubChannel, 'name' | 'topic'>>): Promise<void> {
    await this.requirePermission(hubId, 'manageChannels');
    const channels = await this.store.getHubChannels(hubId);
    const ch = channels.find(c => c.channelId === channelId);
    if (!ch) throw new Error('Channel not found');
    Object.assign(ch, updates);
    await this.store.storeHubChannel(ch);
    await this.syncStructureUpdate(hubId);
  }

  async deleteChannel(hubId: string, channelId: string): Promise<void> {
    await this.requirePermission(hubId, 'manageChannels');
    await this.store.deleteHubChannel(hubId, channelId);
    await this.syncStructureUpdate(hubId);
  }

  // ─── Member Management ──────────────────────────────────────────────────

  async inviteMember(hubId: string, peerId: PeerId): Promise<void> {
    await this.requirePermission(hubId, 'manageMembers');
    const hub = this.hubs.get(hubId);
    if (!hub) throw new Error(`Unknown hub: ${hubId}`);

    const memberProfile = await this.store.getPeerProfile(peerId) || this.node.getKnownPeer(peerId);
    if (!memberProfile) throw new Error(`Cannot invite ${peerId}: no profile`);

    // Encrypt hub key for the target peer
    const hubKeyBytes = new Uint8Array(Buffer.from(hub.hubKey, 'base64'));
    const encryptedKey = encryptForPeer(hubKeyBytes, memberProfile.encryptionPublicKey);

    const msg: HubSyncMessage = {
      type: 'hub_invite',
      hubId,
      from: this.node.getPeerId(),
      payload: {
        name: hub.name,
        description: hub.description,
        icon: hub.icon,
        ownerId: hub.ownerId,
        isPublic: hub.isPublic,
        tags: hub.tags,
        encryptedHubKey: {
          ciphertext: Buffer.from(encryptedKey.ciphertext).toString('base64'),
          nonce: Buffer.from(encryptedKey.nonce).toString('base64'),
          ephemeralPublicKey: Buffer.from(encryptedKey.ephemeralPublicKey).toString('base64'),
          authTag: Buffer.from(encryptedKey.authTag).toString('base64'),
        },
      },
      timestamp: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(msg));
    await this.node.sendToPeer(peerId, PROTOCOLS.HUB_SYNC, data);

    // Store the member locally on the inviter's side
    await this.store.storeHubMember({
      peerId,
      hubId,
      role: 'member',
      joinedAt: Date.now(),
      displayName: memberProfile.displayName,
    });

    console.log(`[Hubs] Invited ${peerId} to "${hub.name}"`);
  }

  async kickMember(hubId: string, peerId: PeerId): Promise<void> {
    const myRole = await this.getMyRole(hubId);
    const targetMember = await this.store.getHubMember(hubId, peerId);
    if (!targetMember) throw new Error('Member not found');

    // Can't kick above own role
    const roleRank: Record<HubRoleType, number> = { owner: 3, admin: 2, member: 1 };
    if (roleRank[targetMember.role] >= roleRank[myRole!]) {
      throw new Error('Cannot kick a member with equal or higher role');
    }

    await this.store.removeHubMember(hubId, peerId);

    // Notify all members
    await this.broadcastToHubMembers(hubId, {
      type: 'hub_member_update',
      hubId,
      from: this.node.getPeerId(),
      payload: { action: 'kicked', peerId },
      timestamp: Date.now(),
    });

    for (const cb of this.onMemberLeft) cb(hubId, peerId);

    // Rotate hub key
    await this.rotateHubKey(hubId);

    console.log(`[Hubs] Kicked ${peerId} from hub ${hubId}`);
  }

  async changeRole(hubId: string, peerId: PeerId, newRole: HubRoleType): Promise<void> {
    const myRole = await this.getMyRole(hubId);
    if (!myRole) throw new Error('Not a member of this hub');

    // Only owner can promote to admin
    if (newRole === 'admin' && myRole !== 'owner') {
      throw new Error('Only the owner can promote to admin');
    }
    // Can't change owner role
    if (newRole === 'owner') {
      throw new Error('Cannot assign owner role');
    }

    const member = await this.store.getHubMember(hubId, peerId);
    if (!member) throw new Error('Member not found');

    member.role = newRole;
    await this.store.storeHubMember(member);

    // Notify all members
    await this.broadcastToHubMembers(hubId, {
      type: 'hub_member_update',
      hubId,
      from: this.node.getPeerId(),
      payload: { action: 'role_change', peerId, newRole },
      timestamp: Date.now(),
    });

    console.log(`[Hubs] Changed ${peerId}'s role to ${newRole} in hub ${hubId}`);
  }

  async rotateHubKey(hubId: string): Promise<void> {
    const hub = this.hubs.get(hubId);
    if (!hub) throw new Error(`Unknown hub: ${hubId}`);

    const newKey = generateGroupKey();
    hub.hubKey = Buffer.from(newKey).toString('base64');
    hub.version++;
    hub.signature = this.signHub(hub);
    await this.store.storeHub(hub);
    this.hubs.set(hubId, hub);

    const members = await this.store.getHubMembers(hubId);
    const myId = this.node.getPeerId();

    for (const member of members) {
      if (member.peerId === myId) continue;

      const memberProfile = await this.store.getPeerProfile(member.peerId) || this.node.getKnownPeer(member.peerId);
      if (!memberProfile) continue;

      const encryptedKey = encryptForPeer(newKey, memberProfile.encryptionPublicKey);
      const msg: HubSyncMessage = {
        type: 'hub_key_update',
        hubId,
        from: myId,
        payload: {
          encryptedHubKey: {
            ciphertext: Buffer.from(encryptedKey.ciphertext).toString('base64'),
            nonce: Buffer.from(encryptedKey.nonce).toString('base64'),
            ephemeralPublicKey: Buffer.from(encryptedKey.ephemeralPublicKey).toString('base64'),
            authTag: Buffer.from(encryptedKey.authTag).toString('base64'),
          },
        },
        timestamp: Date.now(),
      };
      const data = new TextEncoder().encode(JSON.stringify(msg));
      this.node.sendToPeer(member.peerId, PROTOCOLS.HUB_SYNC, data).catch(() => {});
    }

    console.log(`[Hubs] Rotated key for "${hub.name}"`);
  }

  // ─── Messaging ──────────────────────────────────────────────────────────

  async sendChannelMessage(hubId: string, channelId: string, text: string): Promise<string> {
    const hub = this.hubs.get(hubId);
    if (!hub) throw new Error(`Unknown hub: ${hubId}`);

    await this.requirePermission(hubId, 'sendMessages');

    const hubKey = new Uint8Array(Buffer.from(hub.hubKey, 'base64'));
    const myId = this.node.getPeerId();
    const messageId = crypto.randomUUID();

    const message: Message = {
      messageId,
      from: myId,
      to: channelId,
      type: 'text_message' as ContentType,
      body: text,
      attachments: [],
      timestamp: Date.now(),
    };

    const serialized = new TextEncoder().encode(JSON.stringify(message));
    const encrypted = encryptWithGroupKey(serialized, hubKey);

    const syncMsg: HubSyncMessage = {
      type: 'hub_channel_message',
      hubId,
      from: myId,
      payload: {
        channelId,
        ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
        nonce: Buffer.from(encrypted.nonce).toString('base64'),
        authTag: Buffer.from(encrypted.authTag).toString('base64'),
      },
      timestamp: Date.now(),
    };

    // Send to all members
    const members = await this.store.getHubMembers(hubId);
    let delivered = 0;
    for (const member of members) {
      if (member.peerId === myId) continue;
      const data = new TextEncoder().encode(JSON.stringify(syncMsg));
      const response = await this.node.sendToPeer(member.peerId, PROTOCOLS.HUB_SYNC, data);
      if (response) delivered++;
    }

    // Store in history
    const storedMsg: StoredMessage = {
      messageId,
      conversationId: `hub:${hubId}:${channelId}`,
      from: myId,
      to: channelId,
      body: text,
      type: message.type,
      attachments: [],
      timestamp: message.timestamp,
      status: delivered > 0 ? 'delivered' : 'sent',
    };
    await this.store.storeHistoryMessage(storedMsg);

    hub.lastActivityAt = Date.now();
    await this.store.storeHub(hub);

    return messageId;
  }

  // ─── Incoming Message Handlers ──────────────────────────────────────────

  async handleHubSyncMessage(data: string): Promise<string | void> {
    try {
      const msg: HubSyncMessage = JSON.parse(data);
      switch (msg.type) {
        case 'hub_invite':
          await this.handleHubInvite(msg);
          return 'OK';
        case 'hub_join_accept':
          await this.handleJoinAccept(msg);
          return 'OK';
        case 'hub_key_update':
          await this.handleKeyUpdate(msg);
          return 'OK';
        case 'hub_channel_message':
          await this.handleChannelMessage(msg);
          return 'OK';
        case 'hub_update':
          await this.handleHubUpdate(msg);
          return 'OK';
        case 'hub_member_update':
          await this.handleMemberUpdate(msg);
          return 'OK';
        case 'hub_leave':
          await this.handleMemberLeave(msg);
          return 'OK';
        default:
          return 'UNKNOWN';
      }
    } catch (error) {
      console.error(`[Hubs] Error handling sync message:`, error);
      return 'ERROR';
    }
  }

  async handleDiscoveryMessage(data: string): Promise<string | void> {
    try {
      const msg: HubDiscoveryMessage = JSON.parse(data);
      switch (msg.type) {
        case 'hub_listing':
          await this.handleDiscoveryListing(msg);
          return 'OK';
        case 'hub_search': {
          const payload = msg.payload as { searchTerm?: string; tags?: string[]; limit?: number };
          const results = await this.store.searchHubListings(
            payload.searchTerm || '', payload.tags, payload.limit || 20,
          );
          return JSON.stringify({ type: 'hub_search_results', results });
        }
        default:
          return 'OK';
      }
    } catch (error) {
      console.error(`[Hubs] Error handling discovery message:`, error);
      return 'ERROR';
    }
  }

  // ─── Invite Codes ──────────────────────────────────────────────────────

  async createInvite(hubId: string, maxUses: number = 0, expiresAt: number = 0): Promise<HubInvite> {
    await this.requirePermission(hubId, 'manageMembers');
    const invite: HubInvite = {
      inviteId: crypto.randomUUID(),
      hubId,
      creatorId: this.node.getPeerId(),
      maxUses,
      uses: 0,
      expiresAt,
      createdAt: Date.now(),
    };
    await this.store.storeHubInvite(invite);
    return invite;
  }

  getHubInviteCode(invite: HubInvite): string {
    const hub = this.hubs.get(invite.hubId);
    // Use the node's filtered public/relay addresses
    const allAddrs = this.node.getAddresses()
      .filter(a => !a.includes('/::1/'));
    // Filter to only routable addresses (public IPs + public relay circuits)
    const addrs = allAddrs.filter(addr => {
      const match = addr.match(/\/ip4\/([^/]+)\//);
      if (!match) return false;
      const ip = match[1];
      if (ip === '0.0.0.0' || ip === '127.0.0.1') return false;
      if (ip.startsWith('192.168.') || ip.startsWith('10.')) return false;
      if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 16 && second <= 31) return false;
      }
      if (ip.startsWith('169.254.')) return false;
      return true;
    });
    const payload = {
      v: 1,
      t: 'hub',
      i: invite.inviteId,
      h: invite.hubId,
      n: hub?.name || '',
      a: addrs,
      d: this.node.getPeerId(),
      l: this.node.getLibp2pPeerId(), // libp2p PeerId for relay fallback
    };
    const json = JSON.stringify(payload);
    return Buffer.from(json).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async joinViaInvite(code: string): Promise<{ hubId: string; hubName: string }> {
    const padded = code.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const payload = JSON.parse(json);

    if (payload.t !== 'hub') throw new Error('Not a hub invite code');

    // Connect to the inviter (include libp2p PeerId for relay fallback)
    if (payload.a && payload.a.length > 0) {
      try {
        const connectPayload: any = { v: 1, a: payload.a, d: payload.d, n: '' };
        if (payload.l) connectPayload.l = payload.l;
        await this.node.connectWithInvite(
          Buffer.from(JSON.stringify(connectPayload))
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
        );
      } catch {
        // May already be connected
      }
    }

    // Request join via hub sync
    const joinReq: HubSyncMessage = {
      type: 'hub_invite',
      hubId: payload.h,
      from: this.node.getPeerId(),
      payload: {
        action: 'join_request',
        inviteId: payload.i,
        displayName: this.identity.displayName,
      },
      timestamp: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(joinReq));
    const response = await this.node.sendToPeer(payload.d, PROTOCOLS.HUB_SYNC, data);

    if (response) {
      const text = new TextDecoder().decode(response);
      if (text !== 'OK' && text !== 'ERROR') {
        // Response may contain hub state
        try {
          const state = JSON.parse(text);
          if (state.hub) {
            await this.applyHubState(state);
            return { hubId: state.hub.hubId, hubName: state.hub.name };
          }
        } catch {}
      }
    }

    return { hubId: payload.h, hubName: payload.n };
  }

  // ─── Discovery ──────────────────────────────────────────────────────────

  async announceHub(hubId: string): Promise<void> {
    const hub = this.hubs.get(hubId);
    if (!hub || !hub.isPublic) return;

    const members = await this.store.getHubMembers(hubId);
    const listing: HubListing = {
      hubId: hub.hubId,
      name: hub.name,
      description: hub.description,
      icon: hub.icon,
      memberCount: members.length,
      isPublic: true,
      ownerId: hub.ownerId,
      ownerName: this.identity.displayName,
      tags: hub.tags,
      createdAt: hub.createdAt,
      lastActivityAt: hub.lastActivityAt,
      signature: hub.signature,
      hopCount: 0,
      maxHops: 3,
    };

    // Attach ranking fields from stats if available
    const stats = await this.store.getHubStats(hubId);
    if (stats) {
      listing.powerScore = stats.powerScore;
      listing.tier = stats.tier;
      listing.level = stats.level;
      listing.activeMembersWeek = stats.activeMembersWeek;
      listing.messagesPerDay = stats.messagesPerDay;
      listing.dailyMessageCounts = stats.dailyMessageCounts;
      listing.achievements = stats.achievements;
    }

    await this.store.storeHubListing(listing);

    const msg: HubDiscoveryMessage = {
      type: 'hub_listing',
      payload: listing,
      from: this.node.getPeerId(),
      timestamp: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(msg));
    await this.node.broadcastToAll(PROTOCOLS.HUB_DISCOVERY, data);
  }

  async getDiscoveredHubs(searchTerm?: string, tags?: string[]): Promise<HubListing[]> {
    if (searchTerm || (tags && tags.length > 0)) {
      return this.store.searchHubListings(searchTerm || '', tags);
    }
    return this.store.getPublicHubListings();
  }

  // ─── Migration ──────────────────────────────────────────────────────────

  async migrateGroupsToHubs(): Promise<void> {
    const groups = await this.store.getAllGroups();
    for (const group of groups) {
      // Skip if already migrated
      if (this.hubs.has(group.groupId)) continue;
      // Check if a hub with this ID already exists
      const existingHub = await this.store.getHub(group.groupId);
      if (existingHub) continue;

      const hub: Hub = {
        hubId: group.groupId,
        name: group.name,
        description: '',
        ownerId: group.creatorId,
        hubKey: group.groupKey,
        isPublic: false,
        tags: [],
        createdAt: group.createdAt,
        lastActivityAt: group.lastMessageAt,
        version: 1,
        signature: '',
      };

      // Only sign if we're the owner
      if (group.creatorId === this.node.getPeerId()) {
        hub.signature = this.signHub(hub);
      }

      await this.store.storeHub(hub);
      this.hubs.set(hub.hubId, hub);

      // Create default category + channel
      const catId = crypto.randomUUID();
      await this.store.storeHubCategory({ categoryId: catId, hubId: hub.hubId, name: 'TEXT CHANNELS', position: 0 });

      const chId = crypto.randomUUID();
      await this.store.storeHubChannel({
        channelId: chId, hubId: hub.hubId, categoryId: catId,
        name: 'general', type: 'text', position: 0,
      });

      // Add members
      for (const memberId of group.members) {
        await this.store.storeHubMember({
          peerId: memberId,
          hubId: hub.hubId,
          role: memberId === group.creatorId ? 'owner' : 'member',
          joinedAt: group.createdAt,
        });
      }
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  getHubs(): Hub[] {
    return Array.from(this.hubs.values());
  }

  getHub(hubId: string): Hub | undefined {
    return this.hubs.get(hubId);
  }

  async getMyRole(hubId: string): Promise<HubRoleType | null> {
    const member = await this.store.getHubMember(hubId, this.node.getPeerId());
    return member ? member.role : null;
  }

  async getHubState(hubId: string): Promise<{
    hub: Hub;
    categories: HubCategory[];
    channels: HubChannel[];
    members: HubMember[];
  } | null> {
    const hub = this.hubs.get(hubId);
    if (!hub) return null;
    return {
      hub,
      categories: await this.store.getHubCategories(hubId),
      channels: await this.store.getHubChannels(hubId),
      members: await this.store.getHubMembers(hubId),
    };
  }

  // ─── Private: Incoming Handlers ──────────────────────────────────────────

  private async handleHubInvite(msg: HubSyncMessage): Promise<void> {
    const payload = msg.payload as any;

    // Handle join request (we are the inviter)
    if (payload.action === 'join_request') {
      const invite = await this.store.getHubInvite(payload.inviteId);
      if (!invite) return;

      // Check expiry
      if (invite.expiresAt > 0 && Date.now() > invite.expiresAt) return;
      // Check max uses
      if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return;

      // Accept: add member, send hub state
      const hub = this.hubs.get(invite.hubId);
      if (!hub) return;

      await this.store.storeHubMember({
        peerId: msg.from,
        hubId: invite.hubId,
        role: 'member',
        joinedAt: Date.now(),
        displayName: payload.displayName,
      });

      invite.uses++;
      await this.store.storeHubInvite(invite);

      // Send full hub state including encrypted key
      await this.inviteMember(invite.hubId, msg.from);

      for (const cb of this.onMemberJoined) cb(invite.hubId, {
        peerId: msg.from, hubId: invite.hubId, role: 'member',
        joinedAt: Date.now(), displayName: payload.displayName,
      });
      return;
    }

    // Direct invite — decrypt the hub key
    const encryptedKey = payload.encryptedHubKey;
    let hubKey: Uint8Array;
    try {
      hubKey = decryptFromPeer(
        {
          ciphertext: new Uint8Array(Buffer.from(encryptedKey.ciphertext, 'base64')),
          nonce: new Uint8Array(Buffer.from(encryptedKey.nonce, 'base64')),
          ephemeralPublicKey: new Uint8Array(Buffer.from(encryptedKey.ephemeralPublicKey, 'base64')),
          authTag: new Uint8Array(Buffer.from(encryptedKey.authTag, 'base64')),
        },
        this.identity.encryptionPrivateKey,
      );
    } catch (error) {
      console.error(`[Hubs] Failed to decrypt hub key:`, error);
      return;
    }

    const hub: Hub = {
      hubId: msg.hubId,
      name: payload.name,
      description: payload.description || '',
      icon: payload.icon,
      ownerId: payload.ownerId,
      hubKey: Buffer.from(hubKey).toString('base64'),
      isPublic: payload.isPublic || false,
      tags: payload.tags || [],
      createdAt: msg.timestamp,
      lastActivityAt: msg.timestamp,
      version: 1,
      signature: '',
    };

    this.hubs.set(hub.hubId, hub);
    await this.store.storeHub(hub);

    // Add self as member
    await this.store.storeHubMember({
      peerId: this.node.getPeerId(),
      hubId: hub.hubId,
      role: 'member',
      joinedAt: Date.now(),
      displayName: this.identity.displayName,
    });

    // Request full state from the inviter
    const stateReq: HubSyncMessage = {
      type: 'hub_join_accept',
      hubId: hub.hubId,
      from: this.node.getPeerId(),
      payload: { action: 'state_request' },
      timestamp: Date.now(),
    };
    const data = new TextEncoder().encode(JSON.stringify(stateReq));
    const response = await this.node.sendToPeer(msg.from, PROTOCOLS.HUB_SYNC, data);
    if (response) {
      try {
        const text = new TextDecoder().decode(response);
        const state = JSON.parse(text);
        if (state.categories) await this.applyStructure(hub.hubId, state);
      } catch {}
    }

    for (const cb of this.onHubJoined) cb(hub);
    for (const cb of this.onInviteReceived) cb(hub.hubId, hub.name, msg.from);

    const senderProfile = this.node.getKnownPeer(msg.from);
    const senderName = senderProfile?.displayName || msg.from.slice(0, 12);
    console.log(`[Hubs] Invited to "${hub.name}" by ${senderName}`);
  }

  private async handleJoinAccept(msg: HubSyncMessage): Promise<void> {
    const payload = msg.payload as any;
    if (payload.action === 'state_request') {
      // They're requesting our hub state — send it
      const state = await this.getHubState(msg.hubId);
      if (state) {
        // Don't send the hubKey in state (they already have it)
        const safeState = {
          categories: state.categories,
          channels: state.channels,
          members: state.members,
        };
        // The response will be sent back automatically via the stream
        return;
      }
    }
  }

  private async handleKeyUpdate(msg: HubSyncMessage): Promise<void> {
    const hub = this.hubs.get(msg.hubId);
    if (!hub) return;

    const payload = msg.payload as any;
    const encryptedKey = payload.encryptedHubKey;

    try {
      const newKey = decryptFromPeer(
        {
          ciphertext: new Uint8Array(Buffer.from(encryptedKey.ciphertext, 'base64')),
          nonce: new Uint8Array(Buffer.from(encryptedKey.nonce, 'base64')),
          ephemeralPublicKey: new Uint8Array(Buffer.from(encryptedKey.ephemeralPublicKey, 'base64')),
          authTag: new Uint8Array(Buffer.from(encryptedKey.authTag, 'base64')),
        },
        this.identity.encryptionPrivateKey,
      );

      hub.hubKey = Buffer.from(newKey).toString('base64');
      await this.store.storeHub(hub);
      this.hubs.set(hub.hubId, hub);
      console.log(`[Hubs] Updated key for "${hub.name}"`);
    } catch (error) {
      console.error(`[Hubs] Failed to decrypt key update for "${hub.name}":`, error);
    }
  }

  private async handleChannelMessage(msg: HubSyncMessage): Promise<void> {
    const hub = this.hubs.get(msg.hubId);
    if (!hub) return;

    const payload = msg.payload as any;
    const hubKey = new Uint8Array(Buffer.from(hub.hubKey, 'base64'));

    try {
      const decrypted = decryptWithGroupKey(
        new Uint8Array(Buffer.from(payload.ciphertext, 'base64')),
        new Uint8Array(Buffer.from(payload.nonce, 'base64')),
        new Uint8Array(Buffer.from(payload.authTag, 'base64')),
        hubKey,
      );

      const message: Message = JSON.parse(new TextDecoder().decode(decrypted));
      const channelId = payload.channelId;

      const storedMsg: StoredMessage = {
        messageId: message.messageId,
        conversationId: `hub:${msg.hubId}:${channelId}`,
        from: message.from,
        to: channelId,
        body: message.body,
        type: message.type,
        attachments: message.attachments,
        timestamp: message.timestamp,
        status: 'delivered',
      };

      await this.store.storeHistoryMessage(storedMsg);

      hub.lastActivityAt = Date.now();
      await this.store.storeHub(hub);

      for (const cb of this.onChannelMessage) cb(msg.hubId, channelId, storedMsg);
    } catch (error) {
      console.error(`[Hubs] Failed to decrypt channel message:`, error);
    }
  }

  private async handleHubUpdate(msg: HubSyncMessage): Promise<void> {
    const payload = msg.payload as any;

    if (payload.action === 'deleted') {
      this.hubs.delete(msg.hubId);
      await this.store.deleteHub(msg.hubId);
      for (const cb of this.onHubUpdate) cb(msg.hubId, { type: 'deleted' });
      return;
    }

    if (payload.hub) {
      const updatedHub = payload.hub as Hub;
      // Preserve our local hubKey
      const existingHub = this.hubs.get(msg.hubId);
      if (existingHub) {
        updatedHub.hubKey = existingHub.hubKey;
      }
      this.hubs.set(msg.hubId, updatedHub);
      await this.store.storeHub(updatedHub);
      for (const cb of this.onHubUpdate) cb(msg.hubId, { type: 'hub_updated', hub: updatedHub });
    }

    if (payload.categories && payload.channels) {
      await this.applyStructure(msg.hubId, payload);
      for (const cb of this.onHubUpdate) cb(msg.hubId, { type: 'structure_updated' });
    }
  }

  private async handleMemberUpdate(msg: HubSyncMessage): Promise<void> {
    const payload = msg.payload as any;

    if (payload.action === 'kicked') {
      const kickedId = payload.peerId;
      if (kickedId === this.node.getPeerId()) {
        // We were kicked
        this.hubs.delete(msg.hubId);
        await this.store.deleteHub(msg.hubId);
        for (const cb of this.onHubUpdate) cb(msg.hubId, { type: 'kicked' });
      } else {
        await this.store.removeHubMember(msg.hubId, kickedId);
        for (const cb of this.onMemberLeft) cb(msg.hubId, kickedId);
      }
    } else if (payload.action === 'role_change') {
      const member = await this.store.getHubMember(msg.hubId, payload.peerId);
      if (member) {
        member.role = payload.newRole;
        await this.store.storeHubMember(member);
        for (const cb of this.onHubUpdate) cb(msg.hubId, { type: 'role_changed', peerId: payload.peerId, newRole: payload.newRole });
      }
    }
  }

  private async handleMemberLeave(msg: HubSyncMessage): Promise<void> {
    await this.store.removeHubMember(msg.hubId, msg.from);
    for (const cb of this.onMemberLeft) cb(msg.hubId, msg.from);

    // If we're the owner, rotate key
    const hub = this.hubs.get(msg.hubId);
    if (hub && hub.ownerId === this.node.getPeerId()) {
      await this.rotateHubKey(msg.hubId);
    }
  }

  private async handleDiscoveryListing(msg: HubDiscoveryMessage): Promise<void> {
    const listing = msg.payload as HubListing;
    if (!listing.hubId || !listing.isPublic) return;

    // Don't re-gossip our own listings
    if (listing.ownerId === this.node.getPeerId()) return;

    const existing = await this.store.getHubListing(listing.hubId);
    if (existing && existing.lastActivityAt >= listing.lastActivityAt) return;

    listing.hopCount = (listing.hopCount || 0) + 1;
    await this.store.storeHubListing(listing);

    // Re-gossip if under max hops
    if (listing.hopCount < listing.maxHops) {
      const gossipMsg: HubDiscoveryMessage = {
        type: 'hub_listing',
        payload: listing,
        from: this.node.getPeerId(),
        timestamp: Date.now(),
      };
      const data = new TextEncoder().encode(JSON.stringify(gossipMsg));
      await this.node.broadcastToAll(PROTOCOLS.HUB_DISCOVERY, data);
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private signHub(hub: Hub): string {
    const dataToSign = new TextEncoder().encode(JSON.stringify({
      hubId: hub.hubId,
      name: hub.name,
      description: hub.description,
      ownerId: hub.ownerId,
      isPublic: hub.isPublic,
      version: hub.version,
    }));
    return Buffer.from(sign(dataToSign, this.identity.privateKey)).toString('base64');
  }

  private async requirePermission(hubId: string, perm: keyof typeof ROLE_PERMISSIONS.owner): Promise<void> {
    const role = await this.getMyRole(hubId);
    if (!role) throw new Error('Not a member of this hub');
    if (!ROLE_PERMISSIONS[role][perm]) {
      throw new Error(`Insufficient permissions: ${perm} requires admin or higher`);
    }
  }

  private async broadcastToHubMembers(hubId: string, msg: HubSyncMessage): Promise<void> {
    const members = await this.store.getHubMembers(hubId);
    const myId = this.node.getPeerId();
    const data = new TextEncoder().encode(JSON.stringify(msg));

    for (const member of members) {
      if (member.peerId === myId) continue;
      this.node.sendToPeer(member.peerId, PROTOCOLS.HUB_SYNC, data).catch(() => {});
    }
  }

  private async syncStructureUpdate(hubId: string): Promise<void> {
    const categories = await this.store.getHubCategories(hubId);
    const channels = await this.store.getHubChannels(hubId);

    await this.broadcastToHubMembers(hubId, {
      type: 'hub_update',
      hubId,
      from: this.node.getPeerId(),
      payload: { categories, channels },
      timestamp: Date.now(),
    });

    for (const cb of this.onHubUpdate) cb(hubId, { type: 'structure_updated' });
  }

  private async applyStructure(hubId: string, state: { categories?: HubCategory[]; channels?: HubChannel[]; members?: HubMember[] }): Promise<void> {
    if (state.categories) {
      for (const cat of state.categories) {
        await this.store.storeHubCategory(cat);
      }
    }
    if (state.channels) {
      for (const ch of state.channels) {
        await this.store.storeHubChannel(ch);
      }
    }
    if (state.members) {
      for (const member of state.members) {
        await this.store.storeHubMember(member);
      }
    }
  }

  private async applyHubState(state: any): Promise<void> {
    if (state.hub) {
      const hub = state.hub as Hub;
      this.hubs.set(hub.hubId, hub);
      await this.store.storeHub(hub);
    }
    await this.applyStructure(state.hub?.hubId, state);
  }
}
