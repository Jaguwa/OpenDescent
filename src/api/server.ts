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
import type { Message, PeerId, ContentType } from '../types/index.js';
import type { DecentraNode } from '../network/node.js';
import type { LocalStore } from '../storage/store.js';
import type { MessagingService } from '../messaging/delivery.js';
import type { GroupManager, StoredGroup } from '../messaging/groups.js';
import type { ContentManager, SharedFileInfo } from '../content/sharing.js';

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
    this.wss = new WebSocketServer({ server: this.httpServer });
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

    const filePath = path.join(this.frontendDir, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(this.frontendDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    const securityHeaders: Record<string, string> = {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* wss://localhost:*; img-src 'self' data: blob:;",
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

          // Write temp file, share it, clean up
          const tmpDir = path.join(this.tempDir, '.tmp-shares');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
          const tmpPath = path.join(tmpDir, fileName);
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
                bundleFound = true;
                break;
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
