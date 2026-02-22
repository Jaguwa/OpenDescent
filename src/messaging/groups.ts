/**
 * Group Chat Manager — Create groups, manage members, encrypt with shared keys
 *
 * Group encryption model:
 * - Each group has a shared AES-256 symmetric key
 * - The group creator generates the key and distributes it to members
 * - Distribution: the group key is encrypted individually for each member
 *   using their X25519 public key (same as DM encryption)
 * - When a member is removed, the group key is rotated and re-distributed
 *   to remaining members (forward secrecy for removed members)
 *
 * Group messages are encrypted with the shared key (much cheaper than
 * per-recipient encryption for large groups).
 */

import * as crypto from 'crypto';
import type {
  Channel,
  Message,
  PeerId,
  Identity,
  ContentType,
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

/** Wire format for group-related control messages */
interface GroupControlMessage {
  type: 'group_create' | 'group_invite' | 'group_key_update' | 'group_message' | 'group_leave';
  groupId: string;
  from: PeerId;
  payload: unknown;
  timestamp: number;
}

/** Serialized group for storage */
export interface StoredGroup {
  groupId: string;
  name: string;
  creatorId: PeerId;
  members: PeerId[];
  groupKey: string; // base64-encoded AES-256 key
  createdAt: number;
  lastMessageAt: number;
}

export class GroupManager {
  private node: DecentraNode;
  private store: LocalStore;
  private identity: Identity;
  private groups: Map<string, StoredGroup> = new Map();
  private onGroupMessageCallbacks: ((groupId: string, groupName: string, message: Message) => void)[] = [];

  constructor(node: DecentraNode, store: LocalStore) {
    this.node = node;
    this.store = store;
    this.identity = node.getIdentity();
  }

  /** Register callback for incoming group messages */
  onGroupMessage(callback: (groupId: string, groupName: string, message: Message) => void): void {
    this.onGroupMessageCallbacks.push(callback);
  }

  /** Load persisted groups from storage */
  async loadGroups(): Promise<void> {
    const groups = await this.store.getAllGroups();
    for (const group of groups) {
      this.groups.set(group.groupId, group);
    }
    if (groups.length > 0) {
      console.log(`[Groups] Loaded ${groups.length} group(s)`);
    }
  }

  /**
   * Create a new group and distribute the key to initial members.
   */
  async createGroup(name: string, memberIds: PeerId[]): Promise<string> {
    const groupId = crypto.randomUUID();
    const groupKey = generateGroupKey();
    const myId = this.node.getPeerId();

    // Include ourselves in the member list
    const allMembers = [myId, ...memberIds.filter((id) => id !== myId)];

    const group: StoredGroup = {
      groupId,
      name,
      creatorId: myId,
      members: allMembers,
      groupKey: Buffer.from(groupKey).toString('base64'),
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    };

    this.groups.set(groupId, group);
    await this.store.storeGroup(group);

    // Distribute group key to each member (encrypted for their eyes only)
    for (const memberId of memberIds) {
      if (memberId === myId) continue;
      await this.sendGroupInvite(memberId, group, groupKey);
    }

    console.log(`[Groups] Created group "${name}" (${groupId}) with ${allMembers.length} members`);
    return groupId;
  }

  /**
   * Send a message to a group.
   */
  async sendGroupMessage(groupId: string, text: string): Promise<string> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    const groupKey = new Uint8Array(Buffer.from(group.groupKey, 'base64'));
    const myId = this.node.getPeerId();

    const message: Message = {
      messageId: crypto.randomUUID(),
      from: myId,
      to: groupId,
      type: 'text_message' as ContentType,
      body: text,
      attachments: [],
      timestamp: Date.now(),
    };

    // Encrypt with group key
    const serialized = new TextEncoder().encode(JSON.stringify(message));
    const encrypted = encryptWithGroupKey(serialized, groupKey);

    const controlMsg: GroupControlMessage = {
      type: 'group_message',
      groupId,
      from: myId,
      payload: {
        ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
        nonce: Buffer.from(encrypted.nonce).toString('base64'),
        authTag: Buffer.from(encrypted.authTag).toString('base64'),
      },
      timestamp: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(controlMsg));

    // Send to all members except ourselves
    let delivered = 0;
    for (const memberId of group.members) {
      if (memberId === myId) continue;
      const response = await this.node.sendToPeer(memberId, PROTOCOLS.MESSAGE, data);
      if (response) delivered++;
    }

    // Store in conversation history
    await this.store.storeHistoryMessage({
      messageId: message.messageId,
      conversationId: `group:${groupId}`,
      from: myId,
      to: groupId,
      body: text,
      type: message.type,
      attachments: [],
      timestamp: message.timestamp,
      status: delivered > 0 ? 'delivered' : 'sent',
    });

    group.lastMessageAt = Date.now();
    await this.store.storeGroup(group);

    console.log(`[Groups] Message sent to "${group.name}" (${delivered}/${group.members.length - 1} delivered)`);
    return message.messageId;
  }

  /**
   * Handle an incoming group control message.
   * Called by the messaging layer when it detects a group message.
   * Validates sender membership/authorization before processing.
   */
  async handleGroupControlMessage(raw: any): Promise<boolean> {
    if (!raw.type || !raw.groupId) return false;

    const controlMsg = raw as GroupControlMessage;
    const group = this.groups.get(controlMsg.groupId);

    // For messages that require an existing group, verify sender membership
    if (controlMsg.type === 'group_message') {
      if (!group) {
        console.warn(`[Groups] Received message for unknown group ${controlMsg.groupId}`);
        return true; // consumed but ignored
      }
      if (!group.members.includes(controlMsg.from)) {
        console.warn(`[Groups] Rejected group_message from non-member ${controlMsg.from} in "${group.name}"`);
        return true;
      }
    }

    // Key updates must come from the group creator
    if (controlMsg.type === 'group_key_update') {
      if (!group) return true;
      if (controlMsg.from !== group.creatorId) {
        console.warn(`[Groups] Rejected key_update from non-creator ${controlMsg.from} in "${group.name}"`);
        return true;
      }
    }

    // Leave messages: verify the claimed leaver is a current member
    if (controlMsg.type === 'group_leave') {
      if (!group) return true;
      if (!group.members.includes(controlMsg.from)) {
        console.warn(`[Groups] Ignored leave from non-member ${controlMsg.from}`);
        return true;
      }
    }

    switch (controlMsg.type) {
      case 'group_invite':
        await this.handleGroupInvite(controlMsg);
        return true;

      case 'group_message':
        await this.handleIncomingGroupMessage(controlMsg);
        return true;

      case 'group_leave':
        await this.handleMemberLeave(controlMsg);
        return true;

      case 'group_key_update':
        await this.handleKeyUpdate(controlMsg);
        return true;

      default:
        return false;
    }
  }

  /** Leave a group — notify members and remove locally */
  async leaveGroup(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    const myId = this.node.getPeerId();

    // Send leave control message to all members
    const controlMsg: GroupControlMessage = {
      type: 'group_leave',
      groupId,
      from: myId,
      payload: null,
      timestamp: Date.now(),
    };
    const data = new TextEncoder().encode(JSON.stringify(controlMsg));
    for (const memberId of group.members) {
      if (memberId === myId) continue;
      try { await this.node.sendToPeer(memberId, PROTOCOLS.MESSAGE, data); } catch {}
    }

    // Remove locally
    this.groups.delete(groupId);
    await this.store.deleteGroup(groupId);
    console.log(`[Groups] Left group "${group.name}" (${groupId})`);
  }

  /** Get all groups we're in */
  getGroups(): StoredGroup[] {
    return Array.from(this.groups.values());
  }

  /** Find a group by name (partial match) */
  findGroupByName(name: string): StoredGroup | undefined {
    const lower = name.toLowerCase();
    for (const group of this.groups.values()) {
      if (group.name.toLowerCase().includes(lower)) return group;
    }
    return undefined;
  }

  /** Find a group by ID (exact or partial) */
  findGroup(input: string): StoredGroup | undefined {
    // Exact ID
    if (this.groups.has(input)) return this.groups.get(input);
    // By name
    const byName = this.findGroupByName(input);
    if (byName) return byName;
    // Partial ID
    for (const [id, group] of this.groups) {
      if (id.startsWith(input)) return group;
    }
    return undefined;
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private async sendGroupInvite(memberId: PeerId, group: StoredGroup, groupKey: Uint8Array): Promise<void> {
    const memberProfile = await this.store.getPeerProfile(memberId)
      || this.node.getKnownPeer(memberId);

    if (!memberProfile) {
      console.warn(`[Groups] Cannot invite ${memberId}: no profile (not connected)`);
      return;
    }

    // Encrypt the group key for this specific member
    const encryptedKey = encryptForPeer(groupKey, memberProfile.encryptionPublicKey);

    const controlMsg: GroupControlMessage = {
      type: 'group_invite',
      groupId: group.groupId,
      from: this.node.getPeerId(),
      payload: {
        name: group.name,
        members: group.members,
        creatorId: group.creatorId,
        encryptedGroupKey: {
          ciphertext: Buffer.from(encryptedKey.ciphertext).toString('base64'),
          nonce: Buffer.from(encryptedKey.nonce).toString('base64'),
          ephemeralPublicKey: Buffer.from(encryptedKey.ephemeralPublicKey).toString('base64'),
          authTag: Buffer.from(encryptedKey.authTag).toString('base64'),
        },
      },
      timestamp: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(controlMsg));
    await this.node.sendToPeer(memberId, PROTOCOLS.MESSAGE, data);
  }

  private async handleGroupInvite(msg: GroupControlMessage): Promise<void> {
    const payload = msg.payload as any;

    // Decrypt the group key
    const encryptedKey = payload.encryptedGroupKey;
    const groupKey = decryptFromPeer(
      {
        ciphertext: new Uint8Array(Buffer.from(encryptedKey.ciphertext, 'base64')),
        nonce: new Uint8Array(Buffer.from(encryptedKey.nonce, 'base64')),
        ephemeralPublicKey: new Uint8Array(Buffer.from(encryptedKey.ephemeralPublicKey, 'base64')),
        authTag: new Uint8Array(Buffer.from(encryptedKey.authTag, 'base64')),
      },
      this.identity.encryptionPrivateKey,
    );

    const group: StoredGroup = {
      groupId: msg.groupId,
      name: payload.name,
      creatorId: payload.creatorId,
      members: payload.members,
      groupKey: Buffer.from(groupKey).toString('base64'),
      createdAt: msg.timestamp,
      lastMessageAt: msg.timestamp,
    };

    this.groups.set(group.groupId, group);
    await this.store.storeGroup(group);

    const senderProfile = this.node.getKnownPeer(msg.from);
    const senderName = senderProfile?.displayName || msg.from.slice(0, 12);
    console.log(`[Groups] Invited to "${group.name}" by ${senderName}`);
  }

  private async handleIncomingGroupMessage(msg: GroupControlMessage): Promise<void> {
    const group = this.groups.get(msg.groupId);
    if (!group) {
      console.warn(`[Groups] Received message for unknown group ${msg.groupId}`);
      return;
    }

    const payload = msg.payload as any;
    const groupKey = new Uint8Array(Buffer.from(group.groupKey, 'base64'));

    try {
      const decrypted = decryptWithGroupKey(
        new Uint8Array(Buffer.from(payload.ciphertext, 'base64')),
        new Uint8Array(Buffer.from(payload.nonce, 'base64')),
        new Uint8Array(Buffer.from(payload.authTag, 'base64')),
        groupKey,
      );

      const message: Message = JSON.parse(new TextDecoder().decode(decrypted));

      // Store in history
      await this.store.storeHistoryMessage({
        messageId: message.messageId,
        conversationId: `group:${msg.groupId}`,
        from: message.from,
        to: msg.groupId,
        body: message.body,
        type: message.type,
        attachments: message.attachments,
        timestamp: message.timestamp,
        status: 'delivered',
      });

      group.lastMessageAt = Date.now();
      await this.store.storeGroup(group);

      for (const callback of this.onGroupMessageCallbacks) {
        callback(msg.groupId, group.name, message);
      }
    } catch (error) {
      console.error(`[Groups] Failed to decrypt group message:`, error);
    }
  }

  private async handleMemberLeave(msg: GroupControlMessage): Promise<void> {
    const group = this.groups.get(msg.groupId);
    if (!group) return;

    group.members = group.members.filter((m) => m !== msg.from);
    await this.store.storeGroup(group);

    const profile = this.node.getKnownPeer(msg.from);
    const name = profile?.displayName || msg.from.slice(0, 12);
    console.log(`[Groups] ${name} left "${group.name}"`);

    // Rotate group key if we are the creator (prevents removed member from reading future messages)
    if (group.creatorId === this.node.getPeerId()) {
      await this.rotateGroupKey(group.groupId);
    }
  }

  /**
   * Rotate the group key and distribute the new key to all remaining members.
   * Called automatically when a member leaves/is removed.
   */
  async rotateGroupKey(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    const newKey = generateGroupKey();
    group.groupKey = Buffer.from(newKey).toString('base64');
    await this.store.storeGroup(group);

    const myId = this.node.getPeerId();

    // Send the new key to all remaining members (encrypted per-member)
    for (const memberId of group.members) {
      if (memberId === myId) continue;
      await this.sendKeyUpdate(memberId, group, newKey);
    }

    console.log(`[Groups] Rotated key for "${group.name}" — distributed to ${group.members.length - 1} members`);
  }

  /**
   * Explicitly remove a member from a group and rotate the key.
   */
  async removeMember(groupId: string, memberId: PeerId): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);

    if (!group.members.includes(memberId)) return;

    group.members = group.members.filter((m) => m !== memberId);
    await this.store.storeGroup(group);

    // Notify the removed member (send a leave message on their behalf)
    const leaveMsg: GroupControlMessage = {
      type: 'group_leave',
      groupId,
      from: memberId,
      payload: {},
      timestamp: Date.now(),
    };
    const data = new TextEncoder().encode(JSON.stringify(leaveMsg));
    await this.node.sendToPeer(memberId, PROTOCOLS.MESSAGE, data);

    const profile = this.node.getKnownPeer(memberId);
    const name = profile?.displayName || memberId.slice(0, 12);
    console.log(`[Groups] Removed ${name} from "${group.name}"`);

    await this.rotateGroupKey(groupId);
  }

  private async sendKeyUpdate(memberId: PeerId, group: StoredGroup, newKey: Uint8Array): Promise<void> {
    const memberProfile = await this.store.getPeerProfile(memberId)
      || this.node.getKnownPeer(memberId);

    if (!memberProfile) {
      console.warn(`[Groups] Cannot send key update to ${memberId}: no profile`);
      return;
    }

    const encryptedKey = encryptForPeer(newKey, memberProfile.encryptionPublicKey);

    const controlMsg: GroupControlMessage = {
      type: 'group_key_update',
      groupId: group.groupId,
      from: this.node.getPeerId(),
      payload: {
        encryptedGroupKey: {
          ciphertext: Buffer.from(encryptedKey.ciphertext).toString('base64'),
          nonce: Buffer.from(encryptedKey.nonce).toString('base64'),
          ephemeralPublicKey: Buffer.from(encryptedKey.ephemeralPublicKey).toString('base64'),
          authTag: Buffer.from(encryptedKey.authTag).toString('base64'),
        },
      },
      timestamp: Date.now(),
    };

    const data = new TextEncoder().encode(JSON.stringify(controlMsg));
    await this.node.sendToPeer(memberId, PROTOCOLS.MESSAGE, data);
  }

  private async handleKeyUpdate(msg: GroupControlMessage): Promise<void> {
    const group = this.groups.get(msg.groupId);
    if (!group) return;

    const payload = msg.payload as any;
    const encryptedKey = payload.encryptedGroupKey;

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

      group.groupKey = Buffer.from(newKey).toString('base64');
      await this.store.storeGroup(group);
      console.log(`[Groups] Updated key for "${group.name}"`);
    } catch (error) {
      console.error(`[Groups] Failed to decrypt key update for "${group.name}":`, error);
    }
  }
}
