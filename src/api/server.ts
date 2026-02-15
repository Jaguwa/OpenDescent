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

    this.httpServer.listen(port, () => {
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

    const securityHeaders: Record<string, string> = {
      // Note: 'unsafe-inline' required for script-src because the frontend uses inline onclick handlers.
      // XSS is mitigated at the application layer via escapeAttr() and input sanitization (Phase A).
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* wss://localhost:*; img-src 'self' data: blob:; media-src 'self' blob: data:;",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        let content: Buffer | string = fs.readFileSync(filePath);

        // Inject auth token into the HTML page
        if (urlPath === '/index.html') {
          const html = content.toString('utf8');
          const tokenScript = `<script>window.__DECENTRA_TOKEN='${this.authToken}';</script>`;
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
          const response = await this.handleRequest(msg as WSRequest);
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
      console.log(`[API] Browser disconnected (${this.clients.size} client(s))`);
    });
  }

  /** Get the auth token (for external integrations like Electron) */
  getAuthToken(): string {
    return this.authToken;
  }

  // ─── Request Handler ──────────────────────────────────────────────────

  private async handleRequest(req: WSRequest): Promise<WSResponse> {
    const { id, action, data } = req;

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
          if (!text || typeof text !== 'string' || text.length > 50_000) {
            return this.err(id, 'Message too long (max 50,000 chars)');
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
          if (!text || typeof text !== 'string' || text.length > 50_000) {
            return this.err(id, 'Message too long (max 50,000 chars)');
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

        case 'share_file': {
          const { recipientId: to, fileName, fileData } = data;
          const recipientId = this.resolveRecipient(to);
          if (!recipientId) return this.err(id, `Unknown recipient: ${to}`);

          // Size limit: 50MB decoded (base64 is ~33% overhead)
          if (!fileData || typeof fileData !== 'string' || fileData.length > 70_000_000) {
            return this.err(id, 'File too large (max 50MB)');
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
          await this.deps.node.sendToPeer(recipientId, PROTOCOLS.CALL_SIGNAL, signalData);
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
          const { searchTerm, maxResults } = data || {};
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
          const localResults: { peerId: string; displayName: string; isOnline: boolean; hopDistance: number; vouchCount?: number }[] = [];
          for (const p of localPeers) {
            const vc = await this.deps.store.getVouchCount(p.peerId);
            localResults.push({
              peerId: p.peerId,
              displayName: p.displayName || p.peerId.slice(0, 12),
              isOnline: connectedIds.has(p.peerId),
              hopDistance: 1,
              vouchCount: vc.received,
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
                    results.push({ ...r, hopDistance: (r.hopDistance || 1) + 1 });
                  }
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
          await this.deps.node.sendToPeer(frPeerId, FP.FRIEND_REQUEST, frData);
          return this.ok(id, { requestId: friendReq.requestId });
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
          await this.deps.node.sendToPeer(req.from, RP.FRIEND_REQUEST, responseData);
          return this.ok(id, { accepted: rAccept });
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
          return this.ok(id, { discoverable: data.discoverable });
        }

        // ─── Phase 4: Posts & Timeline ──────────────────────────

        case 'create_post': {
          if (!this.deps.posts) return this.err(id, 'Posts not available');
          if (!data.content || typeof data.content !== 'string' || data.content.length > 10_000) {
            return this.err(id, 'Post content too long (max 10,000 chars)');
          }
          const visibility = data.visibility === 'friends' ? 'friends' : 'public';
          const post = await this.deps.posts.createPost(data.content, data.attachments || [], visibility);
          return this.ok(id, post);
        }

        case 'get_timeline': {
          const limit = data?.limit || 50;
          const before = data?.before;
          const posts = await this.deps.store.getTimeline(limit, before);
          // Enrich with like status
          const myId2 = this.deps.node.getPeerId();
          for (const post of posts) {
            const reaction = await this.deps.store.getReaction(post.postId, myId2);
            post.liked = !!reaction;
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

        case 'get_comments': {
          const comments = await this.deps.store.getPostComments(data.postId);
          return this.ok(id, comments);
        }

        case 'upload_media': {
          // For large files (>500KB): write to temp, shard via ContentManager
          if (!this.deps.content) return this.err(id, 'Content manager not available');
          const { base64Data, fileName, mimeType } = data;
          // Size limit: 50MB decoded
          if (!base64Data || typeof base64Data !== 'string' || base64Data.length > 70_000_000) {
            return this.err(id, 'File too large (max 50MB)');
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
          const drop = await this.deps.deadDrops.createDeadDrop(data.content);
          return this.ok(id, { drop });
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

  private resolveRecipient(input: string): string | null {
    if (this.deps.node.getKnownPeer(input)) return input;
    const byName = this.deps.node.findPeerByName(input);
    if (byName) return byName.peerId;
    for (const peer of this.deps.node.getAllKnownPeers()) {
      if (peer.peerId.startsWith(input)) return peer.peerId;
    }
    return null;
  }

  close(): void {
    this.wss.close();
    this.httpServer.close();
  }
}
