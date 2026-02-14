/**
 * DecentraNet — Core Type Definitions
 *
 * These types form the shared vocabulary across all layers of the network.
 */

// ─── Identity ────────────────────────────────────────────────────────────────

/** Base58-encoded hash of public key — the user's network address */
export type PeerId = string;

/** A user's complete identity (private, never transmitted) */
export interface Identity {
  /** Ed25519 public key (shared freely) */
  publicKey: Uint8Array;
  /** Ed25519 private key (never leaves device) */
  privateKey: Uint8Array;
  /** X25519 public key for encryption */
  encryptionPublicKey: Uint8Array;
  /** X25519 private key for encryption */
  encryptionPrivateKey: Uint8Array;
  /** Human-readable display name (optional, self-attested) */
  displayName?: string;
  /** Creation timestamp */
  createdAt: number;
}

/** Public profile info that gets shared with the network */
export interface PeerProfile {
  peerId: PeerId;
  publicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  displayName?: string;
  /** Multiaddrs where this peer can be reached */
  addresses: string[];
  /** Timestamp of last known activity */
  lastSeen: number;
  /** Profile version (increment on update) */
  version: number;
  /** Signature over the profile data (proves ownership) */
  signature: Uint8Array;
}

// ─── Content & Storage ───────────────────────────────────────────────────────

/** Content Identifier — hash-based address for any piece of content */
export type ContentId = string;

/** A single shard of a larger piece of content */
export interface Shard {
  shardId: string;
  contentId: ContentId;
  /** Index of this shard in the erasure-coded set */
  index: number;
  /** Total number of shards (data + parity) */
  totalShards: number;
  /** Minimum shards needed for reconstruction */
  requiredShards: number;
  /** The encrypted shard data */
  data: Uint8Array;
  /** Size in bytes */
  size: number;
}

/** Metadata about stored content (stored in DHT) */
export interface ContentManifest {
  contentId: ContentId;
  author: PeerId;
  type: ContentType;
  totalSize: number;
  shardCount: number;
  requiredShards: number;
  /** Map of shard index -> list of peer IDs holding that shard */
  shardLocations: Map<number, PeerId[]>;
  encryptionNonce: Uint8Array;
  /** Who can decrypt this (empty = public to network) */
  recipients: PeerId[];
  createdAt: number;
  signature: Uint8Array;
}

export enum ContentType {
  TEXT_MESSAGE = 'text_message',
  VOICE_NOTE = 'voice_note',
  VIDEO_NOTE = 'video_note',
  PROFILE_UPDATE = 'profile_update',
  IMAGE = 'image',
  FILE = 'file',
}

// ─── Messaging ───────────────────────────────────────────────────────────────

/** Encrypted message envelope — the wire format */
export interface MessageEnvelope {
  messageId: string;
  from: PeerId;
  /** Recipient's peer ID (or channel ID for group) */
  to: PeerId;
  /** Encrypted payload (only recipient can decrypt) */
  encryptedPayload: Uint8Array;
  /** Encryption nonce */
  nonce: Uint8Array;
  /** Sender's ephemeral public key (for forward secrecy) */
  ephemeralPublicKey: Uint8Array;
  /** AES-GCM authentication tag — required for decryption */
  authTag: Uint8Array;
  timestamp: number;
  /** Signature over the envelope (proves sender) */
  signature: Uint8Array;
  /** TTL in seconds — how long peers should hold this for delivery */
  ttl: number;
  /** Content type hint (not encrypted, helps with prioritization) */
  contentTypeHint: ContentType;
}

/** Decrypted message content */
export interface Message {
  messageId: string;
  from: PeerId;
  to: PeerId;
  type: ContentType;
  /** For text: the text. For media: a ContentId pointing to stored content */
  body: string;
  /** Optional media attachment ContentIds */
  attachments: ContentId[];
  timestamp: number;
  replyTo?: string;
}

/** A conversation channel (DM or group) */
export interface Channel {
  channelId: string;
  type: 'dm' | 'group';
  participants: PeerId[];
  /** Shared symmetric key for group encryption (rotated on membership change) */
  groupKey?: Uint8Array;
  name?: string;
  createdAt: number;
  lastMessageAt: number;
}

// ─── Real-time Calls ─────────────────────────────────────────────────────────

export enum CallType {
  VOICE = 'voice',
  VIDEO = 'video',
}

export enum CallState {
  INITIATING = 'initiating',
  RINGING = 'ringing',
  CONNECTED = 'connected',
  ENDED = 'ended',
  FAILED = 'failed',
}

/** Signaling message for WebRTC call setup */
export interface CallSignal {
  callId: string;
  from: PeerId;
  to: PeerId;
  type: CallType;
  /** WebRTC signaling data (SDP offer/answer, ICE candidates) */
  signalData: unknown;
  state: CallState;
  timestamp: number;
  signature: Uint8Array;
}

// ─── Protocol Messages ───────────────────────────────────────────────────────

export enum ProtocolMessageType {
  PING = 'ping',
  PONG = 'pong',
  PEER_ANNOUNCE = 'peer_announce',
  STORE_SHARD = 'store_shard',
  RETRIEVE_SHARD = 'retrieve_shard',
  SHARD_RESPONSE = 'shard_response',
  SHARD_NOT_FOUND = 'shard_not_found',
  SEND_MESSAGE = 'send_message',
  MESSAGE_ACK = 'message_ack',
  FETCH_MESSAGES = 'fetch_messages',
  CALL_SIGNAL = 'call_signal',
  CALL_RELAY_REQUEST = 'call_relay_request',
  PUBLISH_MANIFEST = 'publish_manifest',
  FIND_CONTENT = 'find_content',
  CONTENT_FOUND = 'content_found',
}

export interface ProtocolMessage {
  type: ProtocolMessageType;
  payload: unknown;
  from: PeerId;
  timestamp: number;
  signature: Uint8Array;
}

// ─── Network Events ──────────────────────────────────────────────────────────

export type NetworkEventType =
  | 'peer:connected'
  | 'peer:disconnected'
  | 'peer:profile_exchanged'
  | 'message:received'
  | 'message:delivered'
  | 'call:incoming'
  | 'call:connected'
  | 'call:ended'
  | 'shard:stored'
  | 'shard:requested'
  | 'content:available';

export interface NetworkEvent {
  type: NetworkEventType;
  peerId?: PeerId;
  data?: unknown;
  timestamp: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NodeConfig {
  port: number;
  wsPort?: number;
  isPublic?: boolean;
  displayName: string;
  bootstrapPeers: string[];
  dataDir: string;
  identityPath: string;
  maxStorageBytes: number;
  maxShards: number;
  enableRelay: boolean;
  messageRetentionSeconds: number;
}

export const DEFAULT_CONFIG: Partial<NodeConfig> = {
  port: 6001,
  dataDir: './data',
  identityPath: './data/identity.json',
  maxStorageBytes: 1024 * 1024 * 512, // 512MB
  maxShards: 10000,
  enableRelay: true,
  messageRetentionSeconds: 7 * 24 * 60 * 60, // 7 days
};
