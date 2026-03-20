/**
 * API Server — HTTP + WebSocket bridge between browser frontend and Node.js backend
 *
 * - HTTP: serves the frontend static files
 * - WebSocket: JSON-RPC-style API for browser clients
 *
 * Browser → WS → Node.js backend → libp2p → network
 * Network → libp2p → Node.js backend → WS → Browser
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Message, PeerId, ContentType, ThemePreferences, UserProfile, FriendRequest, Post, Vouch } from '../types/index.js';
import { sign, verify } from '../crypto/identity.js';
import type { DecentraNode } from '../network/node.js';
import type { LocalStore } from '../storage/store.js';
import type { MessagingService } from '../messaging/delivery.js';
import type { GroupManager, StoredGroup } from '../messaging/groups.js';
import type { ContentManager, SharedFileInfo } from '../content/sharing.js';
import type { PostService } from '../content/posts.js';
import type { TrustWebService } from '../trust/web.js';
import type { DeadDropService } from '../content/deaddrops.js';
import type { PollService } from '../content/polls.js';
import type { HubManager } from '../messaging/hubs.js';
import type { HubStatsService } from '../messaging/hub-stats.js';
import type { DeadManSwitchService } from '../deadswitch/deadswitch.js';
import { verifyLicense, checkLimit, setLicensePublicKey, TIER_LIMITS, type LicenseStatus } from '../licensing/license.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WSRequest {
  type: 'request';
  id: string;
  action: string;
  data?: any;
}

interface WSResponse {
  type: 'response';
  id: string;
  ok: boolean;
  data?: any;
  error?: string;
}

interface WSEvent {
  type: 'event';
  event: string;
  data: any;
}

export interface APIServerDeps {
  node: DecentraNode;
  store: LocalStore;
  messaging: MessagingService;
  groups: GroupManager;
  content: ContentManager;
  posts?: PostService;
  trustWeb?: TrustWebService;
  deadDrops?: DeadDropService;
  polls?: PollService;
  hubs?: HubManager;
  hubStats?: HubStatsService;
  dms?: DeadManSwitchService;
  /** Override frontend static files directory (default: <cwd>/frontend) */
  frontendDir?: string;
  /** Override temp directory for file shares/downloads (default: cwd) */
  tempDir?: string;
}

// ─── MIME Types ─────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ─── Server ─────────────────────────────────────────────────────────────────

export class APIServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private deps: APIServerDeps;
  private clients: Set<WebSocket> = new Set();
  private authenticatedClients: Set<WebSocket> = new Set();
  private authToken: string;
  private frontendDir: string;
  private tempDir: string;
  private callSignals: Map<string, (signal: any) => void> = new Map();
  private wsRateLimiter: Map<WebSocket, { count: number; windowStart: number }> = new Map();
  private licenseStatus: LicenseStatus = { tier: 'free', valid: false };
  private static readonly DEFAULT_GIF_API_KEY = process.env.KLIPY_API_KEY || '';

  constructor(port: number, deps: APIServerDeps) {
    this.deps = deps;
    this.authToken = crypto.randomBytes(32).toString('hex');

    // Resolve frontend directory (configurable for Electron, defaults to <cwd>/frontend)
    this.frontendDir = deps.frontendDir || path.resolve(process.cwd(), 'frontend');
    this.tempDir = deps.tempDir || process.cwd();

    // HTTP server for static files
    this.httpServer = http.createServer((req, res) => {
      this.handleHTTP(req, res);
    });

    // WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: 5 * 1024 * 1024 }); // 5MB limit
    this.wss.on('connection', (ws) => this.handleConnection(ws));

    // Wire up events from the backend
    this.wireBackendEvents();

    // Load license key from storage on startup
    this.loadLicense();

    this.httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[API] Frontend: http://localhost:${port}`);
      console.log(`[API] WebSocket: ws://localhost:${port}/ws`);
    });
  }

  // ─── HTTP Static File Server ────────────────────────────────────────────

  private handleHTTP(req: http.IncomingMessage, res: http.ServerResponse): void {
    let urlPath = req.url || '/';
    if (urlPath === '/') urlPath = '/index.html';

    // Strip query strings
    urlPath = urlPath.split('?')[0];

    const filePath = path.resolve(this.frontendDir, '.' + urlPath);
    const resolvedFrontend = path.resolve(this.frontendDir);

    // Security: prevent directory traversal
    if (!filePath.startsWith(resolvedFrontend + path.sep) && filePath !== resolvedFrontend) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    // Generate per-request nonce for auth token script
    const nonce = crypto.randomBytes(16).toString('base64');

    const securityHeaders: Record<string, string> = {
      // Nonce protects the auth token <script>; script-src-attr allows 75+ inline onclick handlers
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* wss://localhost:*; img-src 'self' data: blob: https://*.klipy.com https://static.klipy.com; media-src 'self' blob: data:;`,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        let content: Buffer | string = fs.readFileSync(filePath);

        // Inject auth token into the HTML page with nonce
        if (urlPath === '/index.html') {
          const html = content.toString('utf8');
          const tokenScript = `<script nonce="${nonce}">window.__DECENTRA_TOKEN='${this.authToken}';</script>`;
          content = Buffer.from(html.replace('</head>', `${tokenScript}\n</head>`));
        }

        res.writeHead(200, { 'Content-Type': mimeType, ...securityHeaders });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }

  // ─── WebSocket Connection Handling ──────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    console.log(`[API] Browser connected (${this.clients.size} client(s))`);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // First message must be auth
        if (!this.authenticatedClients.has(ws)) {
          if (msg.type === 'auth' && msg.token === this.authToken) {
            this.authenticatedClients.add(ws);
            ws.send(JSON.stringify({ type: 'auth', ok: true }));
            return;
          } else {
            ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Invalid token' }));
            ws.close(4001, 'Unauthorized');
            return;
          }
        }

        if (msg.type === 'request') {
          const response = await this.handleRequest(msg as WSRequest, ws);
          ws.send(JSON.stringify(response));
        }
      } catch (error: any) {
        ws.send(JSON.stringify({
          type: 'response',
          id: 'unknown',
          ok: false,
          error: error.message,
        }));
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.authenticatedClients.delete(ws);
      this.wsRateLimiter.delete(ws);
      console.log(`[API] Browser disconnected (${this.clients.size} client(s))`);
    });
  }

  /** Get the auth token (for external integrations like Electron) */
  getAuthToken(): string {
    return this.authToken;
  }

  // ─── Rate Limiting ──────────────────────────────────────────────────

  private isWSRateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    const entry = this.wsRateLimiter.get(ws);
    if (!entry || now - entry.windowStart > 60_000) {
      this.wsRateLimiter.set(ws, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    if (entry.count > 200) {
      console.warn(`[API] WebSocket client exceeded 200 req/60s — rate limited`);
      return true;
    }
    return false;
  }

  // ─── Request Handler ──────────────────────────────────────────────────

  private async handleRequest(req: WSRequest, ws: WebSocket): Promise<WSResponse> {
    const { id, action, data } = req;

    if (this.isWSRateLimited(ws)) {
      return this.err(id, 'Rate limited');
    }

    try {
      switch (action) {
        case 'get_identity': {
          const identity = this.deps.node.getIdentity();
          return this.ok(id, {
            peerId: this.deps.node.getPeerId(),
            displayName: identity.displayName,
            addresses: this.deps.node.getAddresses(),
          });
        }

        case 'get_peers': {
          const peers = this.deps.node.getConnectedPeers();
          return this.ok(id, peers.map((p) => ({
            libp2pId: p.libp2pId,
            decentraId: p.decentraId,
            displayName: p.profile?.displayName,
          })));
        }

        case 'get_contacts': {
          const myId = this.deps.node.getPeerId();
          const profiles = this.deps.node.getAllKnownPeers()
            .filter((p) => p.peerId !== myId);
          const connectedIds = new Set(
            this.deps.node.getConnectedPeers()
              .filter((p) => p.decentraId)
              .map((p) => p.decentraId)
          );
          return this.ok(id, profiles.map((p) => ({
            peerId: p.peerId,
            displayName: p.displayName,
            online: connectedIds.has(p.peerId),
          })));
        }

        case 'send_message': {
          const { to, text } = data;
          if (!text || typeof text !== 'string' || text.length > 2_000_000) {
            return this.err(id, 'Message too large (max 2MB)');
          }
          const recipientId = this.resolveRecipient(to);
          if (!recipientId) return this.err(id, `Unknown recipient: ${to}`);
          const msgId = await this.deps.messaging.sendTextMessage(recipientId, text);
          return this.ok(id, { messageId: msgId });
        }

        case 'get_conversations': {
          const convos = await this.deps.store.getConversations();
          const myId = this.deps.node.getPeerId();
          return this.ok(id, convos.map((c) => {
            const otherId = c.lastMessage.from === myId
              ? c.lastMessage.to : c.lastMessage.from;
            const isGroup = c.conversationId.startsWith('group:');
            let displayName: string;
            if (isGroup) {
              const groupId = c.conversationId.slice(6);
              const group = this.deps.groups.findGroup(groupId);
              displayName = group?.name || groupId.slice(0, 12);
            } else {
              const profile = this.deps.node.getKnownPeer(otherId);
              displayName = profile?.displayName || otherId.slice(0, 12);
            }
            return {
              conversationId: c.conversationId,
              displayName,
              isGroup,
              lastMessage: c.lastMessage,
            };
          }));
        }

        case 'get_history': {
          const { conversationId, limit } = data;
          const messages = await this.deps.store.getConversationHistory(conversationId, limit || 50);
          return this.ok(id, messages);
        }

        case 'create_group': {
          const { name, members } = data;
          const maxMembers = this.getTierLimit('maxGroupMembers');
          if (members.length > maxMembers) {
            return this.err(id, `Group too large (max ${maxMembers} members on free tier — upgrade to Pro for unlimited)`);
          }
          const memberIds: string[] = [];
          for (const m of members) {
            const resolved = this.resolveRecipient(m);
            if (!resolved) return this.err(id, `Unknown member: ${m}`);
            memberIds.push(resolved);
          }
          const groupId = await this.deps.groups.createGroup(name, memberIds);
          return this.ok(id, { groupId });
        }

        case 'send_group_message': {
          const { groupId, text } = data;
          if (!text || typeof text !== 'string' || text.length > 2_000_000) {
            return this.err(id, 'Message too large (max 2MB)');
          }
          const group = this.deps.groups.findGroup(groupId);
          if (!group) return this.err(id, `Unknown group: ${groupId}`);
          const msgId = await this.deps.groups.sendGroupMessage(group.groupId, text);
          return this.ok(id, { messageId: msgId });
        }

        case 'get_groups': {
          const groups = this.deps.groups.getGroups();
          return this.ok(id, groups.map((g) => ({
            groupId: g.groupId,
            name: g.name,
            members: g.members,
            memberCount: g.members.length,
            lastMessageAt: g.lastMessageAt,
          })));
        }

        case 'leave_group': {
          if (!data.groupId) return this.err(id, 'Missing groupId');
          await this.deps.groups.leaveGroup(data.groupId);
          return this.ok(id, { left: true });
        }

        case 'share_file': {
          const { recipientId: to, fileName, fileData } = data;
          const recipientId = this.resolveRecipient(to);
          if (!recipientId) return this.err(id, `Unknown recipient: ${to}`);

          // Size limit based on tier
          const maxFileMB = this.getTierLimit('maxFileSizeMB');
          const maxFileBytes = maxFileMB * 1024 * 1024;
          const maxBase64 = Math.ceil(maxFileBytes * 1.37); // base64 overhead
          if (!fileData || typeof fileData !== 'string' || fileData.length > maxBase64) {
            const tierName = this.licenseStatus.valid ? this.licenseStatus.tier : 'free';
            return this.err(id, `File too large (max ${maxFileMB}MB on ${tierName} tier)`);
          }

          // Sanitize filename to prevent path traversal
          const safeName = path.basename(String(fileName || 'file'));
          if (!safeName || safeName === '.' || safeName === '..') return this.err(id, 'Invalid file name');

          // Write temp file, share it, clean up
          const tmpDir = path.join(this.tempDir, '.tmp-shares');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
          const tmpPath = path.join(tmpDir, safeName);
          fs.writeFileSync(tmpPath, Buffer.from(fileData, 'base64'));

          try {
            const fileInfo = await this.deps.content.shareFile(tmpPath);
            await this.deps.messaging.sendMediaMessage(
              recipientId,
              'file' as ContentType,
              fileInfo.contentId,
              JSON.stringify(fileInfo),
            );
            return this.ok(id, { contentId: fileInfo.contentId, fileName: fileInfo.fileName });
          } finally {
            try { fs.unlinkSync(tmpPath); } catch {}
          }
        }

        case 'download_file': {
          const { fileInfo } = data;
          const tmpDir = path.join(this.tempDir, '.tmp-downloads');
          const outputPath = await this.deps.content.downloadFile(fileInfo, tmpDir);
          const fileData = fs.readFileSync(outputPath).toString('base64');
          try { fs.unlinkSync(outputPath); } catch {}
          return this.ok(id, {
            fileName: fileInfo.fileName,
            mimeType: fileInfo.mimeType,
            fileData,
          });
        }

        // ─── WebRTC Call Signaling ───────────────────────────────
        // Browser sends signaling data here, we relay it through libp2p
        // to the remote peer's browser

        case 'call_signal': {
          const { peerId, signal } = data;
          const recipientId = this.resolveRecipient(peerId);
          if (!recipientId) return this.err(id, `Unknown peer: ${peerId}`);

          const signalData = new TextEncoder().encode(JSON.stringify({
            type: 'webrtc_signal',
            from: this.deps.node.getPeerId(),
            signal,
          }));

          const { PROTOCOLS } = await import('../network/node.js');
          const response = await this.deps.node.sendToPeer(recipientId, PROTOCOLS.CALL_SIGNAL, signalData);
          if (!response) {
            return this.err(id, 'Peer not reachable — call signal could not be delivered');
          }
          return this.ok(id, { sent: true });
        }

        case 'get_invite_code': {
          const code = this.deps.node.getInviteCode();
          return this.ok(id, { code });
        }

        case 'connect_peer': {
          const { code } = data;
          if (!code) return this.err(id, 'Missing invite code');
          const result = await this.deps.node.connectWithInvite(code);
          return this.ok(id, result);
        }

        case 'set_display_name': {
          const { name } = data;
          if (!name || typeof name !== 'string') return this.err(id, 'Name is required');
          const trimmed = name.trim().slice(0, 40);
          if (!trimmed) return this.err(id, 'Name cannot be empty');
          this.deps.node.setDisplayName(trimmed);
          return this.ok(id, { name: trimmed });
        }

        case 'get_storage': {
          return this.ok(id, this.deps.store.getStorageUsage());
        }

        case 'setup_mnemonic': {
          const { generateMnemonic, mnemonicToSeed } = await import('../crypto/mnemonic.js');
          const { generateIdentityFromSeed, publicKeyToPeerId } = await import('../crypto/identity.js');
          const words = generateMnemonic();
          const seed = mnemonicToSeed(words);
          const identity = generateIdentityFromSeed(seed, data?.displayName);
          const peerId = publicKeyToPeerId(identity.publicKey);
          return this.ok(id, { mnemonic: words, peerId });
        }

        case 'confirm_mnemonic': {
          const { validateMnemonic, mnemonicToSeed } = await import('../crypto/mnemonic.js');
          const { generateIdentityFromSeed, publicKeyToPeerId, saveIdentity } = await import('../crypto/identity.js');
          const words: string[] = data.mnemonic;
          if (!validateMnemonic(words)) return this.err(id, 'Invalid mnemonic');
          const seed = mnemonicToSeed(words);
          const identity = generateIdentityFromSeed(seed, data.displayName);
          const peerId = publicKeyToPeerId(identity.publicKey);
          await this.deps.store.setMeta('identity_mode', 'mnemonic');
          return this.ok(id, { peerId, confirmed: true });
        }

        case 'recover_mnemonic': {
          const { validateMnemonic, mnemonicToSeed } = await import('../crypto/mnemonic.js');
          const { generateIdentityFromSeed, publicKeyToPeerId } = await import('../crypto/identity.js');
          const words: string[] = data.mnemonic;
          if (!validateMnemonic(words)) return this.err(id, 'Invalid mnemonic');
          const seed = mnemonicToSeed(words);
          const identity = generateIdentityFromSeed(seed);
          const peerId = publicKeyToPeerId(identity.publicKey);

          // Request bundle from connected peers
          const { PROTOCOLS } = await import('../network/node.js');
          const request = new TextEncoder().encode(JSON.stringify({
            action: 'retrieve',
            peerId,
          }));
          const peers = this.deps.node.getConnectedPeers();
          let bundleFound = false;
          for (const peer of peers) {
            if (!peer.decentraId) continue;
            const response = await this.deps.node.sendToPeer(peer.decentraId, PROTOCOLS.ACCOUNT_BUNDLE, request);
            if (response) {
              const text = new TextDecoder().decode(response);
              if (text !== 'NOT_FOUND' && text !== 'UNSUPPORTED') {
                // Try to decrypt the bundle (encrypted bundles use v:1 envelope)
                try {
                  const envelope = JSON.parse(text);
                  if (envelope.v === 1 && envelope.iv && envelope.data) {
                    // Decrypt with key derived from recovered identity's private key
                    const bundleKey = crypto.createHash('sha256').update(identity.privateKey).digest();
                    const iv = Buffer.from(envelope.iv, 'base64');
                    const authTag = Buffer.from(envelope.authTag, 'base64');
                    const decipher = crypto.createDecipheriv('aes-256-gcm', bundleKey, iv);
                    decipher.setAuthTag(authTag);
                    let decrypted = decipher.update(envelope.data, 'base64', 'utf8');
                    decrypted += decipher.final('utf8');
                    const bundle = JSON.parse(decrypted);
                    await this.deps.store.restoreFromBundle(bundle);
                    bundleFound = true;
                  } else {
                    // Legacy unencrypted bundle
                    await this.deps.store.restoreFromBundle(envelope);
                    bundleFound = true;
                  }
                } catch (decryptErr) {
                  console.warn(`[Recovery] Failed to decrypt bundle from peer:`, decryptErr);
                }
                if (bundleFound) break;
              }
            }
          }

          await this.deps.store.setMeta('identity_mode', 'mnemonic');
          return this.ok(id, { peerId, bundleFound });
        }

        case 'get_account_status': {
          const mode = await this.deps.store.getMeta('identity_mode') || 'legacy';
          return this.ok(id, {
            peerId: this.deps.node.getPeerId(),
            mode,
          });
        }

        // ─── Phase 1: Theme System ──────────────────────────────

        case 'get_theme': {
          const prefs = await this.deps.store.getThemePrefs();
          return this.ok(id, prefs);
        }

        case 'set_theme': {
          const prefs: ThemePreferences = data;
          await this.deps.store.setThemePrefs(prefs);
          return this.ok(id, { saved: true });
        }

        // ─── Phase 2: Profile System ────────────────────────────

        case 'get_profile': {
          const targetId = data?.peerId || this.deps.node.getPeerId();
          const profile = await this.deps.store.getUserProfile(targetId);
          const peerProfile = this.deps.node.getKnownPeer(targetId);
          const friends = await this.deps.store.getFriends();
          const postCount = await this.deps.store.getPostCount(targetId);
          const vouchCount = await this.deps.store.getVouchCount(targetId);
          const myId = this.deps.node.getPeerId();
          const isVouched = targetId !== myId ? !!(await this.deps.store.getVouchByPair(myId, targetId)) : false;
          const isFriendOfTarget = await this.deps.store.isFriend(targetId);
          return this.ok(id, {
            profile,
            displayName: peerProfile?.displayName || targetId.slice(0, 12),
            peerId: targetId,
            friendCount: friends.length,
            postCount,
            vouchCount: vouchCount.received,
            isVouched,
            isFriend: isFriendOfTarget,
            isSelf: targetId === this.deps.node.getPeerId(),
          });
        }

        case 'update_profile': {
          const profile: UserProfile = {
            ...data,
            peerId: this.deps.node.getPeerId(),
            version: (data.version || 0) + 1,
            updatedAt: Date.now(),
            signature: '',
          };
          // Sign the profile with Ed25519
          const profileSignData = new TextEncoder().encode(JSON.stringify({
            peerId: profile.peerId,
            cards: profile.cards,
            cardData: profile.cardData,
            version: profile.version,
            updatedAt: profile.updatedAt,
          }));
          profile.signature = Buffer.from(sign(profileSignData, this.deps.node.getIdentity().privateKey)).toString('base64');
          await this.deps.store.storeUserProfile(profile);
          // Broadcast to connected peers
          const { PROTOCOLS: P } = await import('../network/node.js');
          const profileData = new TextEncoder().encode(JSON.stringify(profile));
          await this.deps.node.broadcastToAll(P.PROFILE_UPDATE, profileData);
          return this.ok(id, { saved: true });
        }

        case 'get_peer_stats': {
          const statsId = data?.peerId || this.deps.node.getPeerId();
          const friends = await this.deps.store.getFriends();
          const postCount = await this.deps.store.getPostCount(statsId);
          const convos = await this.deps.store.getConversations();
          return this.ok(id, {
            friendCount: friends.length,
            postCount,
            conversationCount: convos.length,
          });
        }

        // ─── Phase 3: Discovery & Friend Requests ───────────────

        case 'search_peers': {
          const { searchTerm, maxResults, dhtDiscovery } = data || {};
          const myId = this.deps.node.getPeerId();
          const allPeers = this.deps.node.getAllKnownPeers();
          const connectedIds = new Set(
            this.deps.node.getConnectedPeers().filter(p => p.decentraId).map(p => p.decentraId)
          );

          // Local search
          const term = (searchTerm || '').toLowerCase();
          const localPeers = allPeers
            .filter(p => p.peerId !== myId)
            .filter(p => {
              if (!term) return true;
              return (p.displayName || '').toLowerCase().includes(term) ||
                     p.peerId.toLowerCase().includes(term);
            });
          // Enrich with vouch counts
          const localResults: { peerId: string; displayName: string; isOnline: boolean; hopDistance: number; vouchCount?: number; source?: string }[] = [];
          for (const p of localPeers) {
            const vc = await this.deps.store.getVouchCount(p.peerId);
            localResults.push({
              peerId: p.peerId,
              displayName: p.displayName || p.peerId.slice(0, 12),
              isOnline: connectedIds.has(p.peerId),
              hopDistance: 1,
              vouchCount: vc.received,
              source: 'local',
            });
          }
          let results = localResults;

          // Also query connected peers
          const { PROTOCOLS: SP } = await import('../network/node.js');
          const query = JSON.stringify({ searchTerm: term, maxResults: maxResults || 20 });
          const queryData = new TextEncoder().encode(query);
          const seenIds = new Set(results.map(r => r.peerId));

          for (const peer of this.deps.node.getConnectedPeers()) {
            if (!peer.decentraId) continue;
            try {
              const response = await this.deps.node.sendToPeer(peer.decentraId, SP.PEER_SEARCH, queryData);
              if (response) {
                const text = new TextDecoder().decode(response);
                const remoteResults = JSON.parse(text);
                for (const r of remoteResults) {
                  if (!seenIds.has(r.peerId) && r.peerId !== myId) {
                    seenIds.add(r.peerId);
                    results.push({ ...r, hopDistance: (r.hopDistance || 1) + 1, source: r.source || 'gossip' });
                  }
                }
              }
            } catch {}
          }

          // DHT discovery — if requested or results are sparse
          if (dhtDiscovery || (term && results.length < 3)) {
            try {
              const dhtResults = await this.deps.node.discoverPeers(term, maxResults || 20, 12_000);
              for (const r of dhtResults) {
                if (!seenIds.has(r.peerId) && r.peerId !== myId) {
                  seenIds.add(r.peerId);
                  const vc = await this.deps.store.getVouchCount(r.peerId);
                  results.push({
                    peerId: r.peerId,
                    displayName: r.displayName,
                    isOnline: r.isOnline,
                    hopDistance: 0,
                    vouchCount: vc.received,
                    source: 'dht',
                  });
                }
              }
            } catch {}
          }

          return this.ok(id, results.slice(0, maxResults || 20));
        }

        case 'send_friend_request': {
          const { peerId: frPeerId, message: frMsg } = data;
          const myProfile = this.deps.node.getIdentity();
          const friendReq: FriendRequest = {
            requestId: crypto.randomUUID(),
            from: this.deps.node.getPeerId(),
            to: frPeerId,
            fromName: myProfile.displayName || this.deps.node.getPeerId().slice(0, 12),
            message: frMsg,
            timestamp: Date.now(),
            status: 'pending',
            signature: '',
          };
          // Sign the friend request
          const frSignData = new TextEncoder().encode(JSON.stringify({
            requestId: friendReq.requestId,
            from: friendReq.from,
            to: friendReq.to,
            fromName: friendReq.fromName,
            message: friendReq.message || '',
            timestamp: friendReq.timestamp,
          }));
          friendReq.signature = Buffer.from(sign(frSignData, myProfile.privateKey)).toString('base64');
          await this.deps.store.storeFriendRequest(friendReq);

          // Send to target peer
          const { PROTOCOLS: FP } = await import('../network/node.js');
          const frData = new TextEncoder().encode(JSON.stringify(friendReq));
          const frResponse = await this.deps.node.sendToPeer(frPeerId, FP.FRIEND_REQUEST, frData);
          return this.ok(id, { requestId: friendReq.requestId, delivered: !!frResponse });
        }

        case 'get_friend_requests': {
          const requests = await this.deps.store.getPendingFriendRequests();
          return this.ok(id, requests);
        }

        case 'respond_friend_request': {
          const { requestId: rId, accept: rAccept } = data;
          const req = await this.deps.store.getFriendRequest(rId);
          if (!req) return this.err(id, 'Request not found');
          req.status = rAccept ? 'accepted' : 'rejected';
          await this.deps.store.storeFriendRequest(req);
          if (rAccept) {
            await this.deps.store.addFriend(req.from);
          }
          // Notify the requester
          const { PROTOCOLS: RP } = await import('../network/node.js');
          const responseData = new TextEncoder().encode(JSON.stringify({
            type: 'response',
            requestId: rId,
            accepted: rAccept,
          }));
          const rpResponse = await this.deps.node.sendToPeer(req.from, RP.FRIEND_REQUEST, responseData);
          return this.ok(id, { accepted: rAccept, delivered: !!rpResponse });
        }

        case 'get_friends': {
          const friendIds = await this.deps.store.getFriends();
          const connectedIds2 = new Set(
            this.deps.node.getConnectedPeers().filter(p => p.decentraId).map(p => p.decentraId)
          );
          const friendList = friendIds.map(fId => {
            const profile = this.deps.node.getKnownPeer(fId);
            return {
              peerId: fId,
              displayName: profile?.displayName || fId.slice(0, 12),
              isOnline: connectedIds2.has(fId),
            };
          });
          return this.ok(id, friendList);
        }

        case 'set_discoverable': {
          await this.deps.store.setMeta('discoverable', data.discoverable ? 'true' : 'false');
          if (data.discoverable) {
            this.deps.node.startDirectoryPublishing();
          } else {
            this.deps.node.stopDirectoryPublishing();
          }
          return this.ok(id, { discoverable: data.discoverable });
        }

        case 'discover_network': {
          // Background DHT discovery to warm the peer cache
          this.deps.node.discoverPeers('', 30, 15_000).catch(() => {});
          return this.ok(id, { started: true });
        }

        // ─── Phase 4: Posts & Timeline ──────────────────────────

        case 'create_post': {
          if (!this.deps.posts) return this.err(id, 'Posts not available');
          if (data.content != null && typeof data.content !== 'string') {
            return this.err(id, 'Invalid post content');
          }
          const postContent = data.content || '';
          if (postContent.length > 10_000) {
            return this.err(id, 'Post content too long (max 10,000 chars)');
          }
          if (!postContent && (!data.attachments || data.attachments.length === 0)) {
            return this.err(id, 'Post must have content or attachments');
          }
          const visibility = data.visibility === 'friends' ? 'friends' : 'public';
          const post = await this.deps.posts.createPost(postContent, data.attachments || [], visibility);
          return this.ok(id, post);
        }

        case 'get_timeline': {
          const limit = data?.limit || 50;
          const before = data?.before;
          const allPosts = await this.deps.store.getTimeline(limit + 20, before);
          // Enrich with like status and filter reported content
          const myId2 = this.deps.node.getPeerId();
          const posts = [];
          for (const post of allPosts) {
            const hidden = await this.deps.store.isContentHidden(post.postId);
            const reaction = await this.deps.store.getReaction(post.postId, myId2);
            post.liked = !!reaction;
            (post as any).hidden = hidden;
            posts.push(post);
            if (posts.length >= limit) break;
          }
          return this.ok(id, posts);
        }

        case 'like_post': {
          if (!this.deps.posts) return this.err(id, 'Posts not available');
          await this.deps.posts.likePost(data.postId);
          return this.ok(id, { liked: true });
        }

        case 'unlike_post': {
          if (!this.deps.posts) return this.err(id, 'Posts not available');
          await this.deps.posts.unlikePost(data.postId);
          return this.ok(id, { liked: false });
        }

        case 'comment_post': {
          if (!this.deps.posts) return this.err(id, 'Posts not available');
          if (!data.content || typeof data.content !== 'string' || data.content.length > 5_000) {
            return this.err(id, 'Comment too long (max 5,000 chars)');
          }
          const comment = await this.deps.posts.commentOnPost(data.postId, data.content);
          return this.ok(id, comment);
        }

        case 'delete_post': {
          if (!this.deps.posts) return this.err(id, 'Posts not available');
          if (!data.postId) return this.err(id, 'Missing postId');
          const scope = data.scope || 'everyone';
          if (scope === 'self') {
            // Local-only deletion
            await this.deps.store.deletePost(data.postId);
          } else {
            // Delete for everyone — broadcasts to peers
            await this.deps.posts.deletePost(data.postId);
          }
          return this.ok(id, { deleted: true });
        }

        case 'delete_message': {
          if (!data.conversationId && !data.peerId) return this.err(id, 'Missing conversationId or peerId');
          if (!data.timestamp || !data.messageId) return this.err(id, 'Missing timestamp or messageId');
          const delScope = data.scope || 'self';
          let convoId = data.conversationId;
          const myDelId = this.deps.node.getPeerId();
          if (!convoId && data.peerId) {
            convoId = [myDelId, data.peerId].sort().join(':');
          }
          await this.deps.store.deleteHistoryMessage(convoId, data.timestamp, data.messageId);

          if (delScope === 'everyone' && data.peerId) {
            // Send delete notification to the peer
            const { PROTOCOLS: DP } = await import('../network/node.js');
            const notification = JSON.stringify({
              type: 'delete_message',
              targetId: data.messageId,
              from: myDelId,
              timestamp: Date.now(),
              scope: 'everyone',
              conversationId: convoId,
              msgTimestamp: data.timestamp,
            });
            const notifyData = new TextEncoder().encode(notification);
            // DM: send to the other peer
            await this.deps.node.sendToPeer(data.peerId, DP.DELETE_NOTIFY, notifyData);
          }
          return this.ok(id, { deleted: true });
        }

        case 'get_comments': {
          const comments = await this.deps.store.getPostComments(data.postId);
          return this.ok(id, comments);
        }

        case 'upload_media': {
          // For large files (>500KB): write to temp, shard via ContentManager
          if (!this.deps.content) return this.err(id, 'Content manager not available');
          const { base64Data, fileName, mimeType } = data;
          // Size limit based on tier
          const mediaMaxMB = this.getTierLimit('maxFileSizeMB');
          const mediaMaxBase64 = Math.ceil(mediaMaxMB * 1024 * 1024 * 1.37);
          if (!base64Data || typeof base64Data !== 'string' || base64Data.length > mediaMaxBase64) {
            const mediaTier = this.licenseStatus.valid ? this.licenseStatus.tier : 'free';
            return this.err(id, `File too large (max ${mediaMaxMB}MB on ${mediaTier} tier)`);
          }
          const safeMediaName = path.basename(String(fileName || 'upload'));
          if (!safeMediaName || safeMediaName === '.' || safeMediaName === '..') return this.err(id, 'Invalid file name');
          const buf = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64');
          const tempPath = path.join(this.tempDir, `upload_${crypto.randomUUID()}_${safeMediaName}`);
          fs.writeFileSync(tempPath, buf);
          try {
            const fileInfo = await this.deps.content.shareFile(tempPath);
            fs.unlinkSync(tempPath);
            return this.ok(id, { contentId: fileInfo.contentId, fileInfo });
          } catch (e: any) {
            try { fs.unlinkSync(tempPath); } catch {}
            return this.err(id, e.message);
          }
        }

        case 'download_media': {
          // Reassemble shards for large files
          if (!this.deps.content) return this.err(id, 'Content manager not available');
          const fileInfo2: SharedFileInfo = data.fileInfo;
          const outDir = path.join(this.tempDir, 'downloads');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          const outPath = await this.deps.content.downloadFile(fileInfo2, outDir);
          const fileData = fs.readFileSync(outPath);
          const dataUrl = `data:${data.mimeType || 'application/octet-stream'};base64,${fileData.toString('base64')}`;
          try { fs.unlinkSync(outPath); } catch {}
          return this.ok(id, { dataUrl });
        }

        // ─── Trust Web ──────────────────────────────────────────

        case 'vouch_peer': {
          if (!this.deps.trustWeb) return this.err(id, 'Trust web not available');
          const vouch = await this.deps.trustWeb.vouchForPeer(data.peerId, data.message);
          return this.ok(id, { vouch });
        }

        case 'revoke_vouch': {
          if (!this.deps.trustWeb) return this.err(id, 'Trust web not available');
          await this.deps.trustWeb.revokeVouch(data.vouchId);
          return this.ok(id, { revoked: true });
        }

        case 'get_trust_path': {
          if (!this.deps.trustWeb) return this.err(id, 'Trust web not available');
          const fromId = data.fromId || this.deps.node.getPeerId();
          const result = await this.deps.trustWeb.findTrustPath(fromId, data.toId);
          return this.ok(id, result);
        }

        case 'get_vouches': {
          if (!this.deps.trustWeb) return this.err(id, 'Trust web not available');
          const graph = await this.deps.trustWeb.getVouchGraph(data.peerId);
          return this.ok(id, graph);
        }

        case 'get_vouch_count': {
          const counts = await this.deps.store.getVouchCount(data.peerId);
          return this.ok(id, counts);
        }

        case 'get_my_vouches': {
          const myVouches = await this.deps.store.getVouchesFrom(this.deps.node.getPeerId());
          return this.ok(id, myVouches);
        }

        // ─── Dead Drops ──────────────────────────────────────────

        case 'create_dead_drop': {
          if (!this.deps.deadDrops) return this.err(id, 'Dead drops not available');
          if (!data.content || typeof data.content !== 'string' || data.content.length > 1000) {
            return this.err(id, 'Drop content too long (max 1,000 chars)');
          }
          const result = await this.deps.deadDrops.createDeadDrop(data.content);
          return this.ok(id, { drop: result.drop, warning: result.warning });
        }

        case 'get_dead_drops': {
          if (!this.deps.deadDrops) return this.err(id, 'Dead drops not available');
          const ddLimit = data?.limit || 50;
          const drops = await this.deps.store.getDeadDropFeed(ddLimit);
          const contents: Record<string, string> = {};
          for (const d of drops) {
            const text = this.deps.deadDrops.decryptDrop(d);
            if (text) contents[d.dropId] = text;
          }
          return this.ok(id, { drops, contents });
        }

        case 'vote_dead_drop': {
          if (!this.deps.deadDrops) return this.err(id, 'Dead drops not available');
          if (!data.dropId || !data.direction) return this.err(id, 'Missing dropId or direction');
          const newVotes = await this.deps.deadDrops.voteDrop(data.dropId, data.direction);
          return this.ok(id, { voted: true, votes: newVotes });
        }

        // ─── Encrypted Polls ──────────────────────────────────

        case 'create_poll': {
          if (!this.deps.polls) return this.err(id, 'Polls not available');
          if (!data.question || typeof data.question !== 'string' || data.question.length > 500) {
            return this.err(id, 'Question too long (max 500 chars)');
          }
          if (!data.options || !Array.isArray(data.options) || data.options.length < 2 || data.options.length > 10) {
            return this.err(id, 'Must have 2-10 options');
          }
          const poll = await this.deps.polls.createPoll(
            data.question, data.options, data.durationMs, data.scope, data.groupId,
          );
          return this.ok(id, { poll });
        }

        case 'get_polls': {
          if (!this.deps.polls) return this.err(id, 'Polls not available');
          const pollLimit = data?.limit || 50;
          const polls = await this.deps.store.getPolls(pollLimit, data?.scope, data?.groupId);
          const myId3 = this.deps.node.getPeerId();
          // Enrich with vote/results state
          const enriched = [];
          for (const p of polls) {
            const receipt = await this.deps.store.getVoteReceipt(p.pollId);
            const results = await this.deps.store.getPollResults(p.pollId);
            enriched.push({
              ...p,
              hasVoted: !!receipt,
              votedOptionIndex: receipt?.optionIndex ?? null,
              results: results || null,
              isCreator: p.creatorId === myId3,
            });
          }
          return this.ok(id, enriched);
        }

        case 'cast_vote': {
          if (!this.deps.polls) return this.err(id, 'Polls not available');
          if (!data.pollId || data.optionIndex === undefined) return this.err(id, 'Missing pollId or optionIndex');
          const receipt = await this.deps.polls.castVote(data.pollId, data.optionIndex);
          return this.ok(id, { receipt });
        }

        case 'tally_poll': {
          if (!this.deps.polls) return this.err(id, 'Polls not available');
          if (!data.pollId) return this.err(id, 'Missing pollId');
          const tallyResults = await this.deps.polls.tallyPoll(data.pollId);
          return this.ok(id, { results: tallyResults });
        }

        case 'verify_poll_vote': {
          if (!this.deps.polls) return this.err(id, 'Polls not available');
          if (!data.pollId) return this.err(id, 'Missing pollId');
          const verification = await this.deps.polls.verifyMyVote(data.pollId);
          return this.ok(id, verification);
        }

        case 'get_poll_results': {
          const pr = await this.deps.store.getPollResults(data.pollId);
          const pp = await this.deps.store.getPoll(data.pollId);
          return this.ok(id, { poll: pp, results: pr });
        }

        // ─── Hubs ──────────────────────────────────────────────

        case 'create_hub': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          if (!data.name || typeof data.name !== 'string' || data.name.length > 100) {
            return this.err(id, 'Hub name too long (max 100 chars)');
          }
          // Check hub creation limit
          const maxHubs = this.getTierLimit('maxHubsCreated');
          if (maxHubs !== Infinity) {
            const existingHubs = this.deps.hubs.getHubs();
            const myId = this.deps.node.getPeerId();
            const ownedHubs = existingHubs.filter(h => h.ownerId === myId).length;
            if (ownedHubs >= maxHubs) {
              return this.err(id, `Hub limit reached (max ${maxHubs} on free tier — upgrade to Pro for unlimited)`);
            }
          }
          const hubId = await this.deps.hubs.createHub(
            data.name, data.description || '', !!data.isPublic, data.tags || [], data.icon,
          );
          return this.ok(id, { hubId });
        }

        case 'get_hubs': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const hubs = this.deps.hubs.getHubs();
          const enriched = [];
          for (const h of hubs) {
            const members = await this.deps.store.getHubMembers(h.hubId);
            const myRole = await this.deps.hubs.getMyRole(h.hubId);
            enriched.push({
              hubId: h.hubId,
              name: h.name,
              description: h.description,
              icon: h.icon,
              ownerId: h.ownerId,
              isPublic: h.isPublic,
              tags: h.tags,
              memberCount: members.length,
              myRole,
              lastActivityAt: h.lastActivityAt,
              createdAt: h.createdAt,
            });
          }
          return this.ok(id, enriched);
        }

        case 'get_hub': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const state = await this.deps.hubs.getHubState(data.hubId);
          if (!state) return this.err(id, `Unknown hub: ${data.hubId}`);
          const myRole = await this.deps.hubs.getMyRole(data.hubId);
          return this.ok(id, { ...state, myRole });
        }

        case 'update_hub': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const { hubId: uhId, ...hubUpdates } = data;
          await this.deps.hubs.updateHub(uhId, hubUpdates);
          return this.ok(id, { updated: true });
        }

        case 'delete_hub': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.deleteHub(data.hubId);
          return this.ok(id, { deleted: true });
        }

        case 'leave_hub': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.leaveHub(data.hubId);
          return this.ok(id, { left: true });
        }

        case 'create_category': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const catId = await this.deps.hubs.createCategory(data.hubId, data.name);
          return this.ok(id, { categoryId: catId });
        }

        case 'rename_category': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.renameCategory(data.hubId, data.categoryId, data.name);
          return this.ok(id, { renamed: true });
        }

        case 'delete_category': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.deleteCategory(data.hubId, data.categoryId);
          return this.ok(id, { deleted: true });
        }

        case 'create_channel': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const chId = await this.deps.hubs.createChannel(
            data.hubId, data.categoryId, data.name, data.type || 'text',
          );
          return this.ok(id, { channelId: chId });
        }

        case 'update_channel': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.updateChannel(data.hubId, data.channelId, {
            name: data.name, topic: data.topic,
          });
          return this.ok(id, { updated: true });
        }

        case 'delete_channel': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.deleteChannel(data.hubId, data.channelId);
          return this.ok(id, { deleted: true });
        }

        case 'send_hub_message': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          if (!data.text || typeof data.text !== 'string' || data.text.length > 2_000_000) {
            return this.err(id, 'Message too large (max 2MB)');
          }
          const hmId = await this.deps.hubs.sendChannelMessage(data.hubId, data.channelId, data.text);
          return this.ok(id, { messageId: hmId });
        }

        case 'get_hub_history': {
          const convoId = `hub:${data.hubId}:${data.channelId}`;
          const history = await this.deps.store.getConversationHistory(convoId, data.limit || 50);
          return this.ok(id, history);
        }

        case 'invite_hub_member': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.inviteMember(data.hubId, data.peerId);
          return this.ok(id, { invited: true });
        }

        case 'kick_hub_member': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.kickMember(data.hubId, data.peerId);
          return this.ok(id, { kicked: true });
        }

        case 'change_hub_role': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          await this.deps.hubs.changeRole(data.hubId, data.peerId, data.role);
          return this.ok(id, { changed: true });
        }

        case 'get_hub_members': {
          const hubMembers = await this.deps.store.getHubMembers(data.hubId);
          const connectedIds3 = new Set(
            this.deps.node.getConnectedPeers().filter(p => p.decentraId).map(p => p.decentraId)
          );
          return this.ok(id, hubMembers.map(m => ({
            ...m,
            isOnline: connectedIds3.has(m.peerId),
            displayName: m.displayName || this.deps.node.getKnownPeer(m.peerId)?.displayName || m.peerId.slice(0, 12),
          })));
        }

        case 'create_hub_invite': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const invite = await this.deps.hubs.createInvite(
            data.hubId, data.maxUses || 0, data.expiresAt || 0,
          );
          const code = this.deps.hubs.getHubInviteCode(invite);
          return this.ok(id, { inviteId: invite.inviteId, code });
        }

        case 'join_hub_invite': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const joinResult = await this.deps.hubs.joinViaInvite(data.code);
          return this.ok(id, joinResult);
        }

        case 'get_hub_invites': {
          const invites = await this.deps.store.getHubInvites(data.hubId);
          return this.ok(id, invites);
        }

        case 'discover_hubs': {
          if (!this.deps.hubs) return this.err(id, 'Hubs not available');
          const listings = await this.deps.hubs.getDiscoveredHubs(data?.searchTerm, data?.tags);
          return this.ok(id, listings.slice(0, data?.limit || 50));
        }

        case 'browse_hubs': {
          const hubListings = await this.deps.store.getPublicHubListings();
          return this.ok(id, hubListings.slice(0, data?.limit || 50));
        }

        case 'get_hub_stats': {
          if (!this.deps.hubStats) return this.err(id, 'Hub stats not available');
          if (!data?.hubId) return this.err(id, 'hubId required');
          const hubStatsResult = await this.deps.hubStats.getStats(data.hubId);
          return this.ok(id, hubStatsResult);
        }

        case 'hub_stats_history': {
          if (!this.deps.hubStats) return this.err(id, 'Hub stats not available');
          if (!data?.hubId) return this.err(id, 'hubId required');
          const snapshots = await this.deps.hubStats.getStatsHistory(data.hubId, data.since);
          return this.ok(id, snapshots);
        }

        case 'get_hub_leaderboard': {
          const allStats = await this.deps.store.getAllHubStats();
          const allListings = await this.deps.store.getPublicHubListings();
          const myHubs = this.deps.hubs ? this.deps.hubs.getHubs().map(h => h.hubId) : [];

          // Merge: use local stats for own hubs, listing stats for discovered hubs
          const entries: any[] = [];
          const seen = new Set<string>();

          for (const s of allStats) {
            seen.add(s.hubId);
            const listing = allListings.find(l => l.hubId === s.hubId);
            entries.push({
              hubId: s.hubId,
              name: listing?.name || s.hubId.slice(0, 8),
              icon: listing?.icon,
              memberCount: s.totalMembers,
              powerScore: s.powerScore,
              tier: s.tier,
              level: s.level,
              activeMembersWeek: s.activeMembersWeek,
              messagesPerDay: s.messagesPerDay,
              dailyMessageCounts: s.dailyMessageCounts,
              achievements: s.achievements,
              isJoined: myHubs.includes(s.hubId),
            });
          }

          // Add discovered listings with stats that we don't have locally
          for (const l of allListings) {
            if (seen.has(l.hubId) || !l.powerScore) continue;
            entries.push({
              hubId: l.hubId,
              name: l.name,
              icon: l.icon,
              memberCount: l.memberCount,
              powerScore: l.powerScore,
              tier: l.tier,
              level: l.level,
              activeMembersWeek: l.activeMembersWeek,
              messagesPerDay: l.messagesPerDay,
              dailyMessageCounts: l.dailyMessageCounts,
              achievements: l.achievements,
              isJoined: myHubs.includes(l.hubId),
            });
          }

          entries.sort((a, b) => (b.powerScore || 0) - (a.powerScore || 0));
          return this.ok(id, entries.slice(0, data?.limit || 50));
        }

        // ─── GIF Library (Klipy) ──────────────────────────────

        case 'gif_search': {
          const apiKey = await this.getGifApiKey();
          if (!apiKey) return this.err(id, 'No GIF API key configured — add one in Settings');
          const q = encodeURIComponent(data.q || '');
          const perPage = data.per_page || 24;
          const url = `https://api.klipy.com/api/v1/${apiKey}/gifs/search?q=${q}&per_page=${perPage}&content_filter=medium`;
          try {
            const result = await this.fetchExternal(url);
            const parsed = JSON.parse(result);
            // Klipy returns { result, data: { data: [...gifs], has_next, ... } }
            const gifs = parsed?.data?.data || parsed?.data || [];
            return this.ok(id, { gifs });
          } catch (e: any) {
            return this.err(id, 'GIF search failed: ' + e.message);
          }
        }

        case 'gif_trending': {
          const apiKey = await this.getGifApiKey();
          if (!apiKey) return this.ok(id, { gifs: [] });
          const perPage = data?.per_page || 24;
          const url = `https://api.klipy.com/api/v1/${apiKey}/gifs/trending?per_page=${perPage}`;
          try {
            const result = await this.fetchExternal(url);
            const parsed = JSON.parse(result);
            const gifs = parsed?.data?.data || parsed?.data || [];
            return this.ok(id, { gifs });
          } catch (e: any) {
            return this.err(id, 'GIF trending failed: ' + e.message);
          }
        }

        case 'gif_categories': {
          const apiKey = await this.getGifApiKey();
          if (!apiKey) return this.ok(id, { categories: [] });
          const url = `https://api.klipy.com/api/v1/${apiKey}/gifs/categories`;
          try {
            const result = await this.fetchExternal(url);
            const parsed = JSON.parse(result);
            const categories = parsed?.data?.data || parsed?.data || [];
            return this.ok(id, { categories });
          } catch (e: any) {
            return this.err(id, 'GIF categories failed: ' + e.message);
          }
        }

        case 'set_gif_api_key': {
          if (!data.apiKey || typeof data.apiKey !== 'string') return this.err(id, 'Missing API key');
          const key = data.apiKey.trim().slice(0, 128);
          await this.deps.store.setMeta('gif_api_key', key);
          return this.ok(id, { saved: true });
        }

        case 'get_gif_api_key': {
          const key = await this.deps.store.getMeta('gif_api_key');
          if (!key) return this.ok(id, { maskedKey: null });
          const masked = key.length > 8 ? key.slice(0, 4) + '...' + key.slice(-4) : '****';
          return this.ok(id, { maskedKey: masked });
        }

        case 'export_data': {
          const exportPeerId = this.deps.node.getPeerId();
          const exportResult = await this.deps.store.exportAllData(exportPeerId);
          return this.ok(id, exportResult);
        }

        case 'report_content': {
          if (!data.contentId || !data.reason) return this.err(id, 'Missing contentId or reason');
          const validReasons = ['spam', 'harassment', 'illegal', 'other'];
          if (!validReasons.includes(data.reason)) return this.err(id, 'Invalid reason');
          const report = {
            id: crypto.randomUUID(),
            contentType: data.contentType || 'post',
            contentId: data.contentId,
            reporterId: this.deps.node.getPeerId(),
            reason: data.reason,
            detail: data.detail || undefined,
            timestamp: Date.now(),
          };
          await this.deps.store.storeReport(report);
          return this.ok(id, { reported: true, hidden: await this.deps.store.isContentHidden(data.contentId) });
        }

        case 'remove_friend': {
          if (!data.peerId) return this.err(id, 'Missing peerId');
          await this.deps.store.removeFriend(data.peerId);
          return this.ok(id, { removed: true });
        }

        case 'block_peer': {
          if (!data.peerId) return this.err(id, 'Missing peerId');
          await this.deps.store.blockPeer(data.peerId);
          await this.deps.store.removeFriend(data.peerId);
          return this.ok(id, { blocked: true });
        }

        case 'unblock_peer': {
          if (!data.peerId) return this.err(id, 'Missing peerId');
          await this.deps.store.unblockPeer(data.peerId);
          return this.ok(id, { unblocked: true });
        }

        case 'get_blocked': {
          const blocked = await this.deps.store.getBlockedPeers();
          return this.ok(id, blocked);
        }

        case 'delete_account': {
          if (!data || data.confirm !== 'DELETE') {
            return this.err(id, 'Must confirm with { confirm: "DELETE" }');
          }
          try {
            await this.deps.node.stop();
          } catch {}
          await this.deps.store.wipeAll();
          // Close all WS clients after response sent
          setTimeout(() => {
            for (const client of this.clients) {
              try { client.close(1000, 'Account deleted'); } catch {}
            }
          }, 500);
          return this.ok(id, { deleted: true, message: 'Account deleted. Please restart the application.' });
        }

        // ─── Dead Man's Switch ──────────────────────────────

        case 'dms_create': {
          if (!this.deps.dms) return this.err(id, 'Dead Man\'s Switch not available');
          // Check DMS limit
          const maxDMS = this.getTierLimit('maxDeadManSwitches');
          if (maxDMS === 0) {
            return this.err(id, 'Dead Man\'s Switch is a Pro feature — upgrade to unlock');
          }
          if (maxDMS !== Infinity) {
            const existing = await this.deps.dms.listSwitches();
            const active = existing.filter(s => s.status === 'armed').length;
            if (active >= maxDMS) {
              return this.err(id, `DMS limit reached (max ${maxDMS} — upgrade to Pro for unlimited)`);
            }
          }
          if (!data.recipientIds || !Array.isArray(data.recipientIds) || data.recipientIds.length === 0) {
            return this.err(id, 'At least one recipient required');
          }
          if (!data.message || typeof data.message !== 'string') return this.err(id, 'Message required');
          const switchId = await this.deps.dms.createSwitch(data.recipientIds, data.message, data.windowMs);
          return this.ok(id, { switchId });
        }

        case 'dms_list': {
          if (!this.deps.dms) return this.err(id, 'Dead Man\'s Switch not available');
          const switches = await this.deps.dms.listSwitches();
          return this.ok(id, switches);
        }

        case 'dms_check_in': {
          if (!this.deps.dms) return this.ok(id, { ok: true });
          await this.deps.dms.checkIn();
          return this.ok(id, { ok: true });
        }

        case 'dms_disarm': {
          if (!this.deps.dms) return this.err(id, 'Dead Man\'s Switch not available');
          if (!data.switchId) return this.err(id, 'Missing switchId');
          await this.deps.dms.disarm(data.switchId);
          return this.ok(id, { ok: true });
        }

        case 'dms_delete': {
          if (!this.deps.dms) return this.err(id, 'Dead Man\'s Switch not available');
          if (!data.switchId) return this.err(id, 'Missing switchId');
          await this.deps.dms.deleteSwitch(data.switchId);
          return this.ok(id, { ok: true });
        }

        // ─── Licensing ──────────────────────────────────────────

        case 'get_license_status': {
          return this.ok(id, {
            tier: this.licenseStatus.valid ? this.licenseStatus.tier : 'free',
            valid: this.licenseStatus.valid,
            expiresAt: this.licenseStatus.expiresAt,
            error: this.licenseStatus.error,
            limits: TIER_LIMITS[this.licenseStatus.valid ? this.licenseStatus.tier : 'free'],
          });
        }

        case 'activate_license': {
          if (!data.licenseKey || typeof data.licenseKey !== 'string') {
            return this.err(id, 'Missing license key');
          }
          const peerId = this.deps.node.getPeerId();
          const status = verifyLicense(data.licenseKey.trim(), peerId);
          if (!status.valid) {
            return this.err(id, status.error || 'Invalid license key');
          }
          // Store the valid license key
          await this.deps.store.setMeta('license_key', data.licenseKey.trim());
          this.licenseStatus = status;
          console.log(`[License] Pro license activated (expires ${new Date(status.expiresAt!).toLocaleDateString()})`);
          return this.ok(id, {
            tier: status.tier,
            valid: true,
            expiresAt: status.expiresAt,
            limits: TIER_LIMITS[status.tier],
          });
        }

        case 'get_checkout_url': {
          const checkoutPeerId = this.deps.node.getPeerId();
          const licenseServerUrl = (data && data.licenseServer) || 'http://188.166.151.203:9000';
          try {
            const checkoutResult = await this.postJSON(`${licenseServerUrl}/checkout`, { peerId: checkoutPeerId });
            if (checkoutResult.url) {
              return this.ok(id, { checkoutUrl: checkoutResult.url });
            }
            return this.err(id, checkoutResult.error || 'Could not create checkout session');
          } catch (e: any) {
            return this.err(id, 'License server unreachable: ' + e.message);
          }
        }

        default:
          return this.err(id, `Unknown action: ${action}`);
      }
    } catch (error: any) {
      return this.err(id, error.message);
    }
  }

  // ─── Backend Event Wiring ─────────────────────────────────────────────

  private wireBackendEvents(): void {
    // Incoming DMs
    this.deps.messaging.onMessage((message: Message) => {
      // Check if it's a file share
      if (message.type === ('file' as ContentType)) {
        try {
          const fileInfo: SharedFileInfo = JSON.parse(message.body);
          const senderProfile = this.deps.node.getKnownPeer(message.from);
          this.broadcast({
            type: 'event',
            event: 'file_received',
            data: {
              from: message.from,
              fromName: senderProfile?.displayName || message.from.slice(0, 12),
              fileInfo,
              timestamp: message.timestamp,
            },
          });
          return;
        } catch {}
      }

      const senderProfile = this.deps.node.getKnownPeer(message.from);
      this.broadcast({
        type: 'event',
        event: 'message',
        data: {
          messageId: message.messageId,
          from: message.from,
          fromName: senderProfile?.displayName || message.from.slice(0, 12),
          to: message.to,
          body: message.body,
          type: message.type,
          timestamp: message.timestamp,
        },
      });
    });

    // Incoming group messages
    this.deps.groups.onGroupMessage((groupId, groupName, message) => {
      const senderProfile = this.deps.node.getKnownPeer(message.from);
      this.broadcast({
        type: 'event',
        event: 'group_message',
        data: {
          groupId,
          groupName,
          messageId: message.messageId,
          from: message.from,
          fromName: senderProfile?.displayName || message.from.slice(0, 12),
          body: message.body,
          timestamp: message.timestamp,
        },
      });
    });

    // Peer connected
    this.deps.node.on('peer:connected', (event) => {
      if (event.data && typeof event.data === 'object' && 'displayName' in (event.data as any)) {
        const profile = event.data as any;
        this.broadcast({
          type: 'event',
          event: 'peer_online',
          data: {
            peerId: profile.peerId,
            displayName: profile.displayName,
          },
        });
      }
    });

    // Peer disconnected
    this.deps.node.on('peer:disconnected', (event) => {
      if (event.peerId) {
        const profile = this.deps.node.getKnownPeer(event.peerId);
        this.broadcast({
          type: 'event',
          event: 'peer_offline',
          data: {
            peerId: event.peerId,
            displayName: profile?.displayName,
          },
        });
      }
    });

    // TOFU key change warning
    this.deps.node.on('peer:key_changed', (event) => {
      if (event.data) {
        const data = event.data as any;
        this.broadcast({
          type: 'event',
          event: 'key_changed',
          data: {
            peerId: data.peerId,
            displayName: data.displayName,
          },
        });
      }
    });

    // Post events (Phase 4)
    if (this.deps.posts) {
      this.deps.posts.onPost((post) => {
        this.broadcast({
          type: 'event',
          event: 'new_post',
          data: post,
        });
      });
      this.deps.posts.onInteraction((data) => {
        this.broadcast({
          type: 'event',
          event: 'post_interaction',
          data,
        });
      });
    }

    // Dead drop events
    if (this.deps.deadDrops) {
      this.deps.deadDrops.onNewDrop.push((drop, content) => {
        this.broadcast({ type: 'event', event: 'new_dead_drop', data: { drop, content } });
      });
    }

    // Poll events
    if (this.deps.polls) {
      this.deps.polls.onNewPoll.push((poll) => {
        this.broadcast({ type: 'event', event: 'new_poll', data: poll });
      });
      this.deps.polls.onPollResults.push((poll, results) => {
        this.broadcast({ type: 'event', event: 'poll_results', data: { poll, results } });
      });
      this.deps.polls.onVoteReceived.push((pollId, voterId) => {
        this.broadcast({ type: 'event', event: 'poll_vote_received', data: { pollId, voterId } });
      });
    }

    // Hub events
    if (this.deps.hubs) {
      this.deps.hubs.onChannelMessage.push((hubId, channelId, message) => {
        const senderProfile = this.deps.node.getKnownPeer(message.from);
        this.broadcast({
          type: 'event', event: 'hub_message',
          data: {
            hubId, channelId,
            from: message.from,
            fromName: senderProfile?.displayName || message.from.slice(0, 12),
            body: message.body,
            messageId: message.messageId,
            timestamp: message.timestamp,
          },
        });
      });
      this.deps.hubs.onHubUpdate.push((hubId, update) => {
        this.broadcast({ type: 'event', event: 'hub_updated', data: { hubId, ...update } });
      });
      this.deps.hubs.onHubJoined.push((hub) => {
        this.broadcast({ type: 'event', event: 'hub_joined', data: { hubId: hub.hubId, name: hub.name } });
      });
      this.deps.hubs.onMemberJoined.push((hubId, member) => {
        this.broadcast({
          type: 'event', event: 'hub_member_joined',
          data: { hubId, peerId: member.peerId, displayName: member.displayName },
        });
      });
      this.deps.hubs.onMemberLeft.push((hubId, peerId) => {
        this.broadcast({ type: 'event', event: 'hub_member_left', data: { hubId, peerId } });
      });
      this.deps.hubs.onInviteReceived.push((hubId, hubName, from) => {
        const senderProfile = this.deps.node.getKnownPeer(from);
        this.broadcast({
          type: 'event', event: 'hub_invite_received',
          data: { hubId, hubName, fromName: senderProfile?.displayName || from.slice(0, 12) },
        });
      });
    }

    // Call signaling — relay from libp2p to browser
    this.deps.node.on('call:incoming', (event) => {
      if (event.data) {
        try {
          const signal = typeof event.data === 'string'
            ? JSON.parse(event.data)
            : event.data;

          if (signal.type === 'webrtc_signal') {
            const senderProfile = this.deps.node.getKnownPeer(signal.from);
            this.broadcast({
              type: 'event',
              event: 'call_signal',
              data: {
                from: signal.from,
                fromName: senderProfile?.displayName || signal.from?.slice(0, 12),
                signal: signal.signal,
              },
            });
          }
        } catch {}
      }
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private ok(id: string, data?: any): WSResponse {
    return { type: 'response', id, ok: true, data };
  }

  private err(id: string, error: string): WSResponse {
    return { type: 'response', id, ok: false, error };
  }

  private broadcast(msg: WSEvent): void {
    const json = JSON.stringify(msg);
    for (const client of this.authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  /** Broadcast an event to all authenticated WS clients (for use outside the class) */
  broadcastEvent(event: string, data: Record<string, unknown>): void {
    this.broadcast({ type: 'event', event, data } as WSEvent);
  }

  /**
   * Resolve the GIF API key: local store > env var > fetch from a connected peer (one-time).
   * This lets the relay operator set KLIPY_API_KEY once, and all clients inherit it.
   */
  private async getGifApiKey(): Promise<string> {
    // 1. Check local store (user-configured or previously fetched) with 24h expiry
    const local = await this.deps.store.getMeta('gif_api_key');
    if (local) {
      const ts = await this.deps.store.getMeta('gif_api_key_ts');
      if (!ts || Date.now() - parseInt(ts, 10) < 24 * 60 * 60 * 1000) {
        return local;
      }
      // Expired — clear cached key and re-fetch below
    }

    // 2. Check environment variable (set on relay server)
    if (APIServer.DEFAULT_GIF_API_KEY) {
      return APIServer.DEFAULT_GIF_API_KEY;
    }

    // 3. Ask a connected peer for the network key (relay distributes it)
    const { PROTOCOLS } = await import('../network/node.js');
    for (const peer of this.deps.node.getConnectedPeers()) {
      if (!peer.decentraId) continue;
      try {
        const request = new TextEncoder().encode(JSON.stringify({ action: 'get_gif_key' }));
        const response = await this.deps.node.sendToPeer(peer.decentraId, PROTOCOLS.PEER_SEARCH, request);
        if (response) {
          const text = new TextDecoder().decode(response);
          try {
            const parsed = JSON.parse(text);
            if (parsed.gifApiKey) {
              // Cache locally with timestamp
              await this.deps.store.setMeta('gif_api_key', parsed.gifApiKey);
              await this.deps.store.setMeta('gif_api_key_ts', String(Date.now()));
              return parsed.gifApiKey;
            }
          } catch {}
        }
      } catch {}
    }

    return '';
  }

  /** Load and verify stored license key */
  private async loadLicense(): Promise<void> {
    try {
      const key = await this.deps.store.getMeta('license_key');
      if (key) {
        const peerId = this.deps.node.getPeerId();
        this.licenseStatus = verifyLicense(key, peerId);
        if (this.licenseStatus.valid) {
          console.log(`[License] Pro license active (expires ${new Date(this.licenseStatus.expiresAt!).toLocaleDateString()})`);
        } else {
          console.log(`[License] Stored license invalid: ${this.licenseStatus.error}`);
        }
      }
    } catch {}
  }

  /** Get current tier limits */
  private getTierLimit(limit: keyof typeof TIER_LIMITS.free): number {
    return checkLimit(this.licenseStatus, limit);
  }

  /** POST JSON to an external HTTP endpoint (used for license server) */
  private postJSON(url: string, body: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Request timeout')), 10000);
      const parsed = new URL(url);
      const payload = JSON.stringify(body);
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timeout);
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('Invalid response from license server')); }
        });
        res.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });
      req.on('error', (e) => { clearTimeout(timeout); reject(e); });
      req.write(payload);
      req.end();
    });
  }

  private resolveRecipient(input: string): string | null {
    if (this.deps.node.getKnownPeer(input)) return input;
    const byName = this.deps.node.findPeerByName(input);
    if (byName) return byName.peerId;
    for (const peer of this.deps.node.getAllKnownPeers()) {
      if (peer.peerId.startsWith(input)) return peer.peerId;
    }
    return null;
  }

  private fetchExternal(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Request timeout')), 10000);
      https.get(url, { headers: { 'User-Agent': 'OpenDescent/1.0' } }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          clearTimeout(timeout);
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timeout);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      }).on('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });
  }

  close(): void {
    this.wss.close();
    this.httpServer.close();
  }
}
