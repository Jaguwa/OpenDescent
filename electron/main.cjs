/**
 * DecentraNet — Electron Main Process
 *
 * Starts the same backend services as src/index.ts, then opens a
 * BrowserWindow pointed at the local API server. CommonJS (.cjs)
 * because Electron doesn't support ESM entry points, but we use
 * dynamic import() to load our ESM backend modules.
 */

const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const net = require('net');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free TCP port starting from `preferred`. */
function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', () => {
      // Port busy — try a random one
      const srv2 = net.createServer();
      srv2.listen(0, '127.0.0.1', () => {
        const { port } = srv2.address();
        srv2.close(() => resolve(port));
      });
      srv2.on('error', reject);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let mainWindow = null;
let backendNode = null;
let backendStore = null;
let apiServer = null;

async function startApp() {
  // 1. Find free ports
  const tcpPort = await findFreePort(7001);
  const wsPort = await findFreePort(tcpPort + 1);
  const apiPort = await findFreePort(3100);

  // 2. Data directory — AppData/Roaming/DecentraNet (Windows convention)
  const dataDir = path.join(app.getPath('userData'), 'node-data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // 3. Paths for the API server
  //    In dev:  <project>/frontend
  //    In prod: resources/app/frontend (asar:false, electron-builder copies it)
  const appRoot = app.isPackaged
    ? app.getAppPath()
    : path.resolve(__dirname, '..');
  const frontendDir = path.join(appRoot, 'frontend');
  const tempDir = dataDir;

  // 4. Dynamically import ESM backend modules
  const { DecentraNode } = await import(
    /* webpackIgnore: true */ '../dist/network/node.js'
  );
  const { LocalStore } = await import(
    /* webpackIgnore: true */ '../dist/storage/store.js'
  );
  const { MessagingService } = await import(
    /* webpackIgnore: true */ '../dist/messaging/delivery.js'
  );
  const { GroupManager } = await import(
    /* webpackIgnore: true */ '../dist/messaging/groups.js'
  );
  const { ContentManager } = await import(
    /* webpackIgnore: true */ '../dist/content/sharing.js'
  );
  const { PostService } = await import(
    /* webpackIgnore: true */ '../dist/content/posts.js'
  );
  const { APIServer } = await import(
    /* webpackIgnore: true */ '../dist/api/server.js'
  );

  // 5. Build config (mirrors src/index.ts main())
  const passphrase = 'decentranet-desktop-passphrase';
  const config = {
    port: tcpPort,
    wsPort,
    isPublic: false,
    displayName: `Desktop-${Math.floor(Math.random() * 10000)}`,
    bootstrapPeers: [],
    dataDir,
    identityPath: path.join(dataDir, 'identity.json'),
    maxStorageBytes: 512 * 1024 * 1024,
    maxShards: 10000,
    enableRelay: true,
    messageRetentionSeconds: 7 * 24 * 60 * 60,
  };

  console.log(`[Electron] Starting DecentraNet node on TCP ${tcpPort}, WS ${wsPort}, API ${apiPort}`);
  console.log(`[Electron] Data dir: ${dataDir}`);
  console.log(`[Electron] Frontend: ${frontendDir}`);

  // 6. Wire up backend (same sequence as src/index.ts lines 699-783)
  backendNode = new DecentraNode(config, passphrase);
  backendStore = new LocalStore(config.dataDir, config.maxStorageBytes);

  await backendStore.open();
  await backendNode.start();

  // Restore known peers
  const savedProfiles = await backendStore.getAllPeerProfiles();
  for (const profile of savedProfiles) {
    const libp2pId = await backendStore.getLibp2pId(profile.peerId);
    backendNode.registerKnownPeer(profile, libp2pId || undefined);
  }

  // Store own profile
  const ownProfile = backendNode.getProfile();
  await backendStore.storePeerProfile(ownProfile);

  const messaging = new MessagingService(backendNode, backendStore);
  const groups = new GroupManager(backendNode, backendStore);
  const content = new ContentManager(backendNode, backendStore);
  const posts = new PostService(backendNode, backendStore);

  // Wire group message handler
  messaging.setGroupMessageHandler(groups.handleGroupControlMessage.bind(groups));
  await groups.loadGroups();

  // Wire profile update handler (Phase 2)
  backendNode.setProfileUpdateHandler(async (peerId, data) => {
    try {
      const profile = JSON.parse(data);
      await backendStore.storeUserProfile(profile);
    } catch {}
  });

  // Wire peer search handler (Phase 3)
  backendNode.setPeerSearchHandler(async (queryStr) => {
    try {
      const { searchTerm, maxResults } = JSON.parse(queryStr);
      const term = (searchTerm || '').toLowerCase();
      const allPeers = backendNode.getAllKnownPeers();
      const myId = backendNode.getPeerId();
      const connectedIds = new Set(backendNode.getConnectedPeers().filter(p => p.decentraId).map(p => p.decentraId));
      const results = allPeers
        .filter(p => p.peerId !== myId)
        .filter(p => !term || (p.displayName || '').toLowerCase().includes(term))
        .slice(0, maxResults || 20)
        .map(p => ({ peerId: p.peerId, displayName: p.displayName || p.peerId.slice(0, 12), isOnline: connectedIds.has(p.peerId), hopDistance: 1 }));
      return JSON.stringify(results);
    } catch { return '[]'; }
  });

  // Wire friend request handler (Phase 3)
  backendNode.setFriendRequestHandler(async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'response') {
        const req = await backendStore.getFriendRequest(msg.requestId);
        if (req) { req.status = msg.accepted ? 'accepted' : 'rejected'; await backendStore.storeFriendRequest(req); if (msg.accepted) await backendStore.addFriend(req.to); }
        return 'OK';
      }
      await backendStore.storeFriendRequest(msg);
      return 'RECEIVED';
    } catch { return 'ERROR'; }
  });

  // Wire account bundle handlers
  backendNode.setBundleHandlers(
    async (peerId, data) => { await backendStore.storeBundle(peerId, data); },
    async (peerId) => { return backendStore.getBundle(peerId); },
  );

  // Wire history sync
  backendNode.setHistorySyncHandler(async (requesterId, since) => {
    const myId = backendNode.getPeerId();
    const convoId = [myId, requesterId].sort().join(':');
    const messages = await backendStore.getConversationHistory(convoId, 1000);
    const filtered = messages.filter(m => m.timestamp > since);
    if (filtered.length === 0) return null;
    return new TextEncoder().encode(JSON.stringify(filtered));
  });

  // Wire TOFU
  backendNode.setTofuHandler(async (peerId, publicKey) => {
    const pubKeyHash = crypto.createHash('sha256').update(publicKey).digest('hex');
    const existing = await backendStore.getPinnedKey(peerId);
    if (!existing) {
      await backendStore.storePinnedKey({
        peerId,
        publicKeyHash: pubKeyHash,
        firstSeen: Date.now(),
        lastVerified: Date.now(),
      });
      return true;
    }
    if (existing.publicKeyHash === pubKeyHash) {
      await backendStore.updatePinnedKeyVerified(peerId);
      return true;
    }
    console.warn(`[TOFU] Key change detected for ${peerId}!`);
    return false;
  });

  // Wire shard retrieval
  backendNode.setShardRetrieveHandler(async (shardId) => {
    const shard = await backendStore.getShard(shardId);
    if (!shard) return null;
    const payload = JSON.stringify({
      shardId: shard.shardId,
      contentId: shard.contentId,
      index: shard.index,
      totalShards: shard.totalShards,
      requiredShards: shard.requiredShards,
      data: Buffer.from(shard.data).toString('base64'),
      size: shard.size,
    });
    return new TextEncoder().encode(payload);
  });

  // Persist peer profiles on connect
  backendNode.on('peer:connected', async (event) => {
    if (event.data && typeof event.data === 'object' && 'peerId' in event.data) {
      const peerProfile = event.data;
      await backendStore.storePeerProfile(peerProfile);
      const connectedPeers = backendNode.getConnectedPeers();
      const match = connectedPeers.find((p) => p.decentraId === peerProfile.peerId);
      if (match) {
        await backendStore.storePeerIdMapping(match.libp2pId, peerProfile.peerId);
      }
    }
  });

  // Periodic cleanup of expired pending messages (hourly)
  setInterval(() => backendStore.cleanExpiredMessages(config.messageRetentionSeconds), 60 * 60 * 1000);

  // 7. Start API server with custom paths
  apiServer = new APIServer(apiPort, {
    node: backendNode,
    store: backendStore,
    messaging,
    groups,
    content,
    posts,
    frontendDir,
    tempDir,
  });

  // 8. Create the browser window
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'DecentraNet',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://localhost:${apiPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function shutdown() {
  console.log('[Electron] Shutting down...');
  if (apiServer) {
    try { apiServer.close(); } catch {}
  }
  if (backendNode) {
    try { await backendNode.stop(); } catch {}
  }
  if (backendStore) {
    try { await backendStore.close(); } catch {}
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startApp().catch((err) => {
    console.error('[Electron] Fatal error:', err);
    app.quit();
  });
});

app.on('window-all-closed', async () => {
  await shutdown();
  app.quit();
});

app.on('before-quit', async () => {
  await shutdown();
});
