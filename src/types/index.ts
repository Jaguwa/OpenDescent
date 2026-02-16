/**
 * DecentraNet — Core Type Definitions
 *
 * These types form the shared vocabulary across all layers of the network.
 */

// ─── Identity ────────────────────────────────────────────────────────────────

/** Base58-encoded hash of public key — the user's network address */
export type PeerId = string;

/** How this identity was created */
export type IdentityMode = 'mnemonic' | 'legacy';

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
  /** SHA-256 hash of shard data for integrity verification */
  hash?: string;
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
  | 'peer:key_changed'
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
  announceIp?: string;
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

// ─── Theme System (Phase 1: Artify) ─────────────────────────────────────────

/** All CSS custom property values as camelCase fields */
export interface ThemeVars {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  green: string;
  red: string;
  orange: string;
  msgSent: string;
  msgReceived: string;
  radius: string;
  radiusLg: string;
}

/** A named theme preset */
export interface ThemePreset {
  id: string;
  name: string;
  vars: ThemeVars;
}

/** Background display mode */
export interface BackgroundConfig {
  mode: 'solid' | 'gradient' | 'pattern';
  colors: string[];
  angle?: number;
  patternType?: 'dots' | 'grid' | 'diagonal' | 'circuit' | 'waves';
  animationType?: 'none' | 'drift' | 'aurora' | 'particles' | 'mesh' | 'fireflies';
  animationSpeed?: 'slow' | 'normal' | 'fast';
}

/** Chat bubble display style */
export type BubbleStyle = 'modern' | 'classic' | 'minimal' | 'rounded';

/** User's complete theme preferences */
export interface ThemePreferences {
  presetId: string;
  customOverrides?: Partial<ThemeVars>;
  background?: BackgroundConfig;
  fontSize?: number;
  bubbleStyle?: BubbleStyle;
  fontFamily?: string;
}

// ─── Profile System (Phase 2: The Canvas) ───────────────────────────────────

/** Types of profile cards in the bento grid */
export type ProfileCardType = 'identity' | 'vibe' | 'about' | 'now' | 'stats' | 'pinned' | 'music' | 'connections';

/** Card size in the bento grid */
export type ProfileCardSize = 'small' | 'medium' | 'large';

/** A single card configuration */
export interface ProfileCard {
  type: ProfileCardType;
  enabled: boolean;
  order: number;
  size: ProfileCardSize;
}

/** Card-specific data */
export interface VibeCardData {
  emoji: string;
  text: string;
  gradientStart: string;
  gradientEnd: string;
}

export interface AboutCardData {
  text: string;
  fontStyle: 'sans' | 'serif' | 'mono' | 'handwritten';
}

export interface NowCardData {
  text: string;
  updatedAt: number;
}

export interface MusicCardData {
  title: string;
  artist: string;
  emoji: string;
}

/** A user's complete profile */
export interface UserProfile {
  peerId: PeerId;
  cards: ProfileCard[];
  cardData: {
    vibe?: VibeCardData;
    about?: AboutCardData;
    now?: NowCardData;
    music?: MusicCardData;
    tagline?: string;
    pinnedPostId?: string;
  };
  version: number;
  updatedAt: number;
  signature: string;
}

// ─── Discovery & Friend Requests (Phase 3) ──────────────────────────────────

/** Friend request between peers */
export interface FriendRequest {
  requestId: string;
  from: PeerId;
  to: PeerId;
  fromName: string;
  message?: string;
  timestamp: number;
  status: 'pending' | 'accepted' | 'rejected';
  signature: string;
}

/** Query for searching peers across the network */
export interface PeerSearchQuery {
  queryId: string;
  searchTerm: string;
  interests?: string[];
  maxResults: number;
  hopCount: number;
  maxHops: number;
  origin: PeerId;
}

/** A peer found via search */
export interface DiscoveredPeer {
  peerId: PeerId;
  displayName: string;
  bio?: string;
  interests?: string[];
  isOnline: boolean;
  hopDistance: number;
}

// ─── Posts & Timeline (Phase 4) ──────────────────────────────────────────────

/** Media attached to a post */
export interface MediaAttachment {
  type: 'image' | 'video' | 'voicenote' | 'audio';
  contentId: string;
  mimeType: string;
  thumbnail?: string;
  duration?: number;
  fileName?: string;
  fileSize?: number;
  /** Inline base64 data URL for small media (<500KB: voicenotes, images, audio) */
  data?: string;
}

/** Post visibility */
export type PostVisibility = 'public' | 'friends';

/** A post in the timeline */
export interface Post {
  postId: string;
  authorId: PeerId;
  authorName?: string;
  content: string;
  mediaAttachments: MediaAttachment[];
  timestamp: number;
  signature: string;
  parentPostId?: string;
  likeCount: number;
  commentCount: number;
  liked?: boolean;
  hopCount: number;
  maxHops: number;
  /** Who can see this post — 'public' (default) or 'friends' only */
  visibility?: PostVisibility;
}

/** A reaction to a post */
export interface PostReaction {
  reactionId: string;
  postId: string;
  authorId: PeerId;
  type: 'like';
  timestamp: number;
  signature: string;
}

/** A comment on a post */
export interface PostComment {
  commentId: string;
  postId: string;
  authorId: PeerId;
  authorName?: string;
  content: string;
  timestamp: number;
  signature: string;
}

// ─── Trust Web ───────────────────────────────────────────────────────────────

/** A signed vouch — "I trust this peer" */
export interface Vouch {
  vouchId: string;
  fromId: PeerId;
  toId: PeerId;
  fromName?: string;
  toName?: string;
  message?: string;
  timestamp: number;
  signature: string;
  hopCount: number;
  maxHops: number;
}

/** Revoke a previously issued vouch */
export interface VouchRevocation {
  revocationId: string;
  vouchId: string;
  fromId: PeerId;
  timestamp: number;
  signature: string;
}

/** A node in a trust path */
export interface TrustPathNode {
  peerId: PeerId;
  displayName?: string;
}

/** Result of a trust path query */
export interface TrustPathResult {
  found: boolean;
  path: TrustPathNode[];
  distance: number;
}

// ─── Dead Drops ──────────────────────────────────────────────────────────────

/** An anonymous post — no authorId, no signature, zero attribution */
export interface DeadDrop {
  dropId: string;          // random UUID
  ciphertext: string;      // base64, AES-256-GCM encrypted content
  nonce: string;           // base64, 12-byte AES nonce
  authTag: string;         // base64, 16-byte GCM auth tag
  timestamp: number;       // set by exit relay, NOT author
  expiresAt: number;       // timestamp + 24h
  proofOfWork: string;     // hex SHA-256 hash with leading zero bits
  powNonce: number;        // nonce that produces the PoW hash
  votes: number;           // net score (up - down)
}

/** A vote on a dead drop — anonymous, gossiped */
export interface DeadDropVote {
  dropId: string;
  voteId: string;          // random UUID
  direction: 'up' | 'down';
  timestamp: number;
}

/** One layer of onion encryption for relay routing */
export interface OnionLayer {
  nextHop: string;         // DecentraNet PeerId of next relay (empty = exit)
  innerPayload: string;    // base64 encrypted next layer (or final content at exit)
}

// ─── Encrypted Polls ─────────────────────────────────────────────────────────

/** Where a poll lives */
export type PollScope = 'public' | 'group';

/** Status lifecycle of a poll */
export type PollStatus = 'open' | 'closed' | 'tallied';

/** A poll created by a peer */
export interface Poll {
  pollId: string;
  creatorId: PeerId;
  creatorName?: string;
  question: string;
  options: string[];
  scope: PollScope;
  groupId?: string;
  status: PollStatus;
  createdAt: number;
  expiresAt: number;
  durationMs: number;
  voteCount: number;
  signature: string;
  hopCount: number;
  maxHops: number;
}

/** Encrypted vote — sent directly to creator via POLL_VOTE protocol */
export interface EncryptedVote {
  pollId: string;
  voterId: PeerId;
  encryptedPayload: string;
  timestamp: number;
}

/** Plaintext inside EncryptedVote (encrypted with creator's X25519 pubkey) */
export interface VotePlaintext {
  pollId: string;
  optionIndex: number;
  voteSecret: string;
}

/** Published results with cryptographic proof */
export interface PollResults {
  pollId: string;
  creatorId: PeerId;
  tally: number[];
  proofHashes: string[];
  tallySignature: string;
  publishedAt: number;
}

/** Voter-side receipt stored locally after casting a vote */
export interface PollVoteReceipt {
  pollId: string;
  optionIndex: number;
  voteSecret: string;
  timestamp: number;
}

// ─── Hubs ─────────────────────────────────────────────────────────────────

export type HubRoleType = 'owner' | 'admin' | 'member';
export type HubChannelType = 'text' | 'voice';

export interface HubPermissions {
  manageHub: boolean;
  manageChannels: boolean;
  manageMembers: boolean;
  sendMessages: boolean;
  joinVoice: boolean;
}

export const HUB_ROLE_PERMISSIONS: Record<HubRoleType, HubPermissions> = {
  owner:  { manageHub: true,  manageChannels: true,  manageMembers: true,  sendMessages: true,  joinVoice: true },
  admin:  { manageHub: false, manageChannels: true,  manageMembers: true,  sendMessages: true,  joinVoice: true },
  member: { manageHub: false, manageChannels: false, manageMembers: false, sendMessages: true,  joinVoice: true },
};

export interface Hub {
  hubId: string;
  name: string;
  description: string;
  icon?: string;
  ownerId: PeerId;
  hubKey: string;
  isPublic: boolean;
  tags: string[];
  createdAt: number;
  lastActivityAt: number;
  version: number;
  signature: string;
}

export interface HubCategory {
  categoryId: string;
  hubId: string;
  name: string;
  position: number;
}

export interface HubChannel {
  channelId: string;
  hubId: string;
  categoryId: string;
  name: string;
  type: HubChannelType;
  position: number;
  topic?: string;
}

export interface HubMember {
  peerId: PeerId;
  hubId: string;
  role: HubRoleType;
  joinedAt: number;
  displayName?: string;
}

export interface HubInvite {
  inviteId: string;
  hubId: string;
  creatorId: PeerId;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdAt: number;
}

export interface HubListing {
  hubId: string;
  name: string;
  description: string;
  icon?: string;
  memberCount: number;
  isPublic: boolean;
  ownerId: PeerId;
  ownerName?: string;
  tags: string[];
  createdAt: number;
  lastActivityAt: number;
  signature: string;
  hopCount: number;
  maxHops: number;
}

// ─── Account Recovery ────────────────────────────────────────────────────────

/** Account bundle distributed to network peers for recovery */
export interface AccountBundle {
  version: number;
  peerId: PeerId;
  contacts: PeerId[];
  groups: { groupId: string; name: string; groupKey: string; members: PeerId[] }[];
  hubs?: { hubId: string; name: string; hubKey: string }[];
  settings: { displayName?: string; themePrefs?: ThemePreferences };
  updatedAt: number;
  signature: Uint8Array;
}

// ─── TOFU (Trust On First Use) ───────────────────────────────────────────────

/** Pinned public key for a peer (first-seen trust model) */
export interface PinnedKey {
  peerId: PeerId;
  publicKeyHash: string;
  firstSeen: number;
  lastVerified: number;
}
