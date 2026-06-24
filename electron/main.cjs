/**
 * OpenDescent — Electron Main Process
 *
 * Starts the same backend services as src/index.ts, then opens a
 * BrowserWindow pointed at the local API server. CommonJS (.cjs)
 * because Electron doesn't support ESM entry points, but we use
 * dynamic import() to load our ESM backend modules.
 */

const { app, BrowserWindow, dialog, session, desktopCapturer } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const net = require('net');

// ─── Log to file ─────────────────────────────────────────────────────────────

const logPath = path.join(app.getPath('userData'), 'opendescent.log');
const logStream = fs.createWriteStream(logPath, { flags: 'w' });
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
console.log = (...args) => { const msg = args.map(String).join(' '); logStream.write(`[LOG] ${msg}\n`); origLog(...args); };
console.error = (...args) => { const msg = args.map(String).join(' '); logStream.write(`[ERR] ${msg}\n`); origErr(...args); };
console.warn = (...args) => { const msg = args.map(String).join(' '); logStream.write(`[WRN] ${msg}\n`); origWarn(...args); };
origLog(`[Electron] Logs: ${logPath}`);

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
let triggerUpdateCheck = null; // set by the auto-updater; lets the UI request a manual check

async function startApp() {
  // 1. Find free ports
  const tcpPort = await findFreePort(7001);
  const wsPort = await findFreePort(tcpPort + 1);
  const apiPort = await findFreePort(3100);

  // 2. Data directory — AppData/Roaming/OpenDescent (Windows convention)
  //    Migrate from old DecentraNet location if it exists
  const dataDir = path.join(app.getPath('userData'), 'node-data');
  if (!fs.existsSync(dataDir)) {
    const oldDir = path.join(path.dirname(app.getPath('userData')), 'decentra-net', 'node-data');
    if (fs.existsSync(oldDir)) {
      console.log(`[Electron] Migrating data from ${oldDir} to ${dataDir}`);
      fs.cpSync(oldDir, dataDir, { recursive: true });
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  // 3. Paths for the API server
  //    In dev:  <project>/frontend
  //    In prod: resources/app/frontend (asar:false, electron-builder copies it)
  const appRoot = app.isPackaged
    ? app.getAppPath()
    : path.resolve(__dirname, '..');
  const frontendDir = path.join(appRoot, 'frontend');
  const tempDir = dataDir;

  // 4. Dynamically import ESM backend modules
  const { DecentraNode, PROTOCOLS } = await import(
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
  const { TrustWebService } = await import(
    /* webpackIgnore: true */ '../dist/trust/web.js'
  );
  const { DeadDropService } = await import(
    /* webpackIgnore: true */ '../dist/content/deaddrops.js'
  );
  const { PollService } = await import(
    /* webpackIgnore: true */ '../dist/content/polls.js'
  );
  const { HubManager } = await import(
    /* webpackIgnore: true */ '../dist/messaging/hubs.js'
  );
  const { APIServer } = await import(
    /* webpackIgnore: true */ '../dist/api/server.js'
  );

  // 5. Build config (mirrors src/index.ts main())
  // Per-device passphrase: generate a random key on first run, reuse on subsequent runs
  const deviceKeyFile = path.join(dataDir, '.device-key');
  const identityFile = path.join(dataDir, 'identity.json');
  let passphrase;
  if (fs.existsSync(deviceKeyFile)) {
    passphrase = fs.readFileSync(deviceKeyFile, 'utf8').trim();
  } else if (fs.existsSync(identityFile)) {
    // Existing identity from before device-key — auto-migrate to random device key
    const legacyPassphrase = 'decentranet-desktop-passphrase';
    try {
      const { loadIdentity: loadId, saveIdentity: saveId } = await import('./dist/crypto/identity.js');
      const identity = loadId(identityFile, legacyPassphrase);
      const newKey = crypto.randomBytes(32).toString('hex');
      saveId(identity, identityFile, newKey);
      fs.writeFileSync(deviceKeyFile, newKey);
      passphrase = newKey;
      console.log('[Security] Migrated legacy passphrase to device-specific key.');
    } catch {
      passphrase = legacyPassphrase;
      console.warn('[Security] Legacy passphrase migration failed. Using legacy default.');
    }
  } else {
    // Fresh install — generate random device-specific key
    passphrase = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(deviceKeyFile, passphrase);
    console.log('[Security] Generated device-specific encryption key.');
  }
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

  console.log(`[Electron] Starting OpenDescent node on TCP ${tcpPort}, WS ${wsPort}, API ${apiPort}`);
  console.log(`[Electron] Data dir: ${dataDir}`);
  console.log(`[Electron] Frontend: ${frontendDir}`);

  // 6. Wire up backend (same sequence as src/index.ts lines 699-783)
  backendNode = new DecentraNode(config, passphrase);
  backendStore = new LocalStore(config.dataDir, config.maxStorageBytes);

  await backendStore.open();

  // Apply persisted network settings saved from Settings → Relay & Network.
  // The .exe has no CLI flags, so this is how a desktop user points the app
  // at their own relay. Read before start() — node config is read at startup.
  const persistedRelay = (await backendStore.getMeta('custom_relay')) || '';
  if (persistedRelay && !config.bootstrapPeers.includes(persistedRelay)) {
    config.bootstrapPeers.unshift(persistedRelay);
  }
  if ((await backendStore.getMeta('relay_only')) === 'true') {
    config.disableDefaultBootstrap = true;
  }

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

  // Start DHT directory publishing if discoverable (default: true)
  const discoverable = await backendStore.getMeta('discoverable');
  if (discoverable !== 'false') {
    backendNode.startDirectoryPublishing();
  }

  const messaging = new MessagingService(backendNode, backendStore);
  const groups = new GroupManager(backendNode, backendStore);
  const content = new ContentManager(backendNode, backendStore);
  const posts = new PostService(backendNode, backendStore);
  const trustWeb = new TrustWebService(backendNode, backendStore);
  const deadDrops = new DeadDropService(backendNode, backendStore);
  const polls = new PollService(backendNode, backendStore);
  const hubs = new HubManager(backendNode, backendStore);

  // Wire poll handlers
  backendNode.setPollBroadcastHandler(async (data) => {
    await polls.handleIncomingBroadcast(data);
  });
  backendNode.setPollVoteHandler(async (data) => {
    await polls.handleIncomingVote(data);
  });

  // Wire dead drop handlers
  backendNode.setDeadDropBroadcastHandler(async (data) => {
    await deadDrops.handleIncomingBroadcast(data);
  });
  backendNode.setDeadDropRelayHandler(async (data) => {
    await deadDrops.handleRelayMessage(data);
  });

  // Wire vouch broadcast handler (Trust Web)
  backendNode.setVouchBroadcastHandler(async (data) => {
    await trustWeb.handleIncomingVouch(data);
  });

  // Wire hub handlers
  backendNode.setHubSyncHandler(async (data) => {
    return await hubs.handleHubSyncMessage(data);
  });
  backendNode.setHubDiscoveryHandler(async (data) => {
    return await hubs.handleDiscoveryMessage(data);
  });
  await hubs.loadHubs();

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
      const parsed = JSON.parse(queryStr);

      // Handle GIF API key requests — relay distributes its key to the network
      if (parsed.action === 'get_gif_key') {
        const key = process.env.KLIPY_API_KEY || await backendStore.getMeta('gif_api_key') || '';
        return JSON.stringify({ gifApiKey: key });
      }

      const { searchTerm, maxResults } = parsed;
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

  // ─── Broadcast feed sync (mirrors src/index.ts) ────────────────────────────
  // The desktop app previously never synced the public feed, so it only ever
  // showed posts created locally. This pulls broadcast posts/vouches that peers
  // (including the always-on relay) accumulated while this client was offline.
  const FEED_WINDOW_DAYS = 90;

  backendNode.setFeedSyncHandler(async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'digest_request') {
        const digest = await posts.getPostDigest(msg.since || 0);
        const vouchIds = await backendStore.getAllVouchIds();
        const revocationIds = await backendStore.getAllRevocationIds();
        return JSON.stringify({ type: 'digest', ...digest, vouchIds, revocationIds });
      }
      if (msg.type === 'sync_request') {
        const allPosts = await posts.getPostsSince(msg.since || 0, 200);
        const excludeSet = new Set(msg.exclude || []);
        const filtered = allPosts.filter((p) => !excludeSet.has(p.postId));
        const excludeVouches = new Set(msg.excludeVouches || []);
        const allVouches = await backendStore.getAllVouches();
        const newVouches = allVouches.filter((v) => !excludeVouches.has(v.vouchId));
        return JSON.stringify({ type: 'sync_response', posts: filtered, vouches: newVouches });
      }
      return 'OK';
    } catch {
      return 'ERROR';
    }
  });

  async function syncFeedWithPeer(peerId) {
    const peerName = backendNode.getKnownPeer(peerId)?.displayName || peerId.slice(0, 12);
    console.log(`[FeedSync] Starting sync with ${peerName}...`);
    try {
      const since = Date.now() - (FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const digestReq = new TextEncoder().encode(JSON.stringify({ type: 'digest_request', since }));
      const digestResp = await backendNode.sendToPeer(peerId, PROTOCOLS.FEED_SYNC, digestReq);
      if (!digestResp) { console.log(`[FeedSync] No response from ${peerName}`); return; }
      const digest = JSON.parse(new TextDecoder().decode(digestResp));
      console.log(`[FeedSync] ${peerName} has ${digest.count} posts, ${(digest.vouchIds || []).length} vouches`);
      if (digest.type !== 'digest') return;
      const ourPostIds = await backendStore.getPostIds(since);
      const ourVouchIds = await backendStore.getAllVouchIds();
      const missingPosts = (digest.postIds || []).filter((id) => !new Set(ourPostIds).has(id));
      const missingVouches = (digest.vouchIds || []).filter((id) => !new Set(ourVouchIds).has(id));
      if (missingPosts.length === 0 && missingVouches.length === 0) return;
      const syncReq = new TextEncoder().encode(JSON.stringify({
        type: 'sync_request', since, exclude: ourPostIds, excludeVouches: ourVouchIds,
      }));
      const syncResp = await backendNode.sendToPeer(peerId, PROTOCOLS.FEED_SYNC, syncReq);
      if (!syncResp) return;
      const syncData = JSON.parse(new TextDecoder().decode(syncResp));
      if (syncData.type !== 'sync_response') return;
      let importedPosts = 0;
      if (syncData.posts && syncData.posts.length > 0) {
        importedPosts = await posts.importPosts(syncData.posts);
      }
      let importedVouches = 0;
      if (syncData.vouches && syncData.vouches.length > 0) {
        for (const vouch of syncData.vouches) {
          const existing = await backendStore.getVouch(vouch.vouchId);
          if (!existing && !(await backendStore.isRevoked(vouch.vouchId))) {
            await backendStore.storeVouch(vouch);
            importedVouches++;
          }
        }
      }
      if (importedPosts > 0 || importedVouches > 0) {
        console.log(`[FeedSync] Synced ${importedPosts} post(s), ${importedVouches} vouch(es) from ${peerName}`);
      }
    } catch (err) {
      console.log(`[FeedSync] Sync with ${peerName} failed: ${err?.message?.slice(0, 60) || 'unknown'}`);
    }
  }

  // Remote post/message deletion propagation
  let deleteNotifyBroadcast = null;
  backendNode.setDeleteNotifyHandler(async (data) => {
    try {
      const notification = JSON.parse(data);
      if (notification.type === 'delete_message' && notification.conversationId && notification.msgTimestamp && notification.targetId) {
        await backendStore.deleteHistoryMessage(notification.conversationId, notification.msgTimestamp, notification.targetId);
        console.log(`[Delete] Remote deletion: message ${notification.targetId} from ${notification.from}`);
        if (deleteNotifyBroadcast) {
          deleteNotifyBroadcast('message_deleted', {
            conversationId: notification.conversationId,
            messageId: notification.targetId,
            from: notification.from,
          });
        }
      }
    } catch (e) {
      console.warn('[Delete] Failed to process notification:', e.message);
    }
  });

  // Persist peer profiles on connect, then catch up on their broadcast feed
  backendNode.on('peer:connected', async (event) => {
    if (event.data && typeof event.data === 'object' && 'peerId' in event.data) {
      const peerProfile = event.data;
      await backendStore.storePeerProfile(peerProfile);
      const connectedPeers = backendNode.getConnectedPeers();
      const match = connectedPeers.find((p) => p.decentraId === peerProfile.peerId);
      if (match) {
        await backendStore.storePeerIdMapping(match.libp2pId, peerProfile.peerId);
      }
      // Pull broadcast posts/vouches this peer (incl. the relay) has that we missed
      setTimeout(() => syncFeedWithPeer(peerProfile.peerId), 6000);
    }
  });

  // Periodic cleanup of expired pending messages (hourly)
  setInterval(() => backendStore.cleanExpiredMessages(config.messageRetentionSeconds), 60 * 60 * 1000);

  // Periodic cleanup of expired dead drops (every 30 minutes)
  setInterval(async () => {
    const cleaned = await backendStore.cleanExpiredDrops();
    if (cleaned > 0) console.log(`[DeadDrops] Cleaned ${cleaned} expired drops`);
  }, 30 * 60 * 1000);

  // Periodic cleanup of expired polls (every 15 minutes)
  setInterval(async () => {
    const closed = await backendStore.closeExpiredPolls();
    if (closed > 0) console.log(`[Polls] Closed ${closed} expired polls`);
  }, 15 * 60 * 1000);

  // Startup feed sync: catch up with all connected peers (incl. the relay)
  setTimeout(async () => {
    const connectedPeers = backendNode.getConnectedPeers().filter((p) => p.decentraId);
    for (let i = 0; i < connectedPeers.length; i++) {
      const peer = connectedPeers[i];
      if (peer.decentraId) {
        setTimeout(() => syncFeedWithPeer(peer.decentraId), i * 2000);
      }
    }
  }, 8000);

  // Periodic broadcast-post cleanup (older than the 90-day feed window)
  setInterval(async () => {
    const cleaned = await backendStore.cleanOldPosts(FEED_WINDOW_DAYS);
    if (cleaned > 0) console.log(`[FeedSync] Cleaned ${cleaned} expired post(s)`);
  }, 6 * 60 * 60 * 1000);

  // 7. Start API server with custom paths
  apiServer = new APIServer(apiPort, {
    node: backendNode,
    store: backendStore,
    messaging,
    groups,
    content,
    posts,
    trustWeb,
    deadDrops,
    polls,
    hubs,
    frontendDir,
    tempDir,
    checkForUpdatesNow: () => { if (triggerUpdateCheck) triggerUpdateCheck(true); },
  });

  // Let remote deletions push a live UI update
  deleteNotifyBroadcast = (event, data) => apiServer.broadcastEvent(event, data);

  // 8. Create the browser window
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'OpenDescent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  // Enable getDisplayMedia() for screen capture (required for live streaming)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      // Use the primary screen by default
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback({});
    });
  });

  mainWindow.loadURL(`http://localhost:${apiPort}`);

  // Allow F12 to toggle DevTools (DevTools don't auto-open in production)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ─── Auto-update (packaged builds only) ────────────────────────────────────
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      const status = (state, extra = {}) => {
        try { if (apiServer) apiServer.broadcastEvent('update_status', { state, ...extra }); } catch {}
      };

      autoUpdater.on('checking-for-update', () => status('checking'));
      autoUpdater.on('update-not-available', (info) => status('up_to_date', { version: info && info.version }));
      autoUpdater.on('download-progress', (p) => status('downloading', { percent: Math.round((p && p.percent) || 0) }));
      autoUpdater.on('error', (err) => status('error', { message: ((err && err.message) || 'unknown').slice(0, 120) }));

      autoUpdater.on('update-available', (info) => {
        status('available', { version: info && info.version });
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Available',
          message: `Version ${info.version} is available. Download now?`,
          buttons: ['Download', 'Later'],
        }).then((r) => { if (r.response === 0) autoUpdater.downloadUpdate(); });
      });

      autoUpdater.on('update-downloaded', () => {
        status('downloaded');
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Ready',
          message: 'Restart to install the update?',
          buttons: ['Restart', 'Later'],
        }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
      });

      // Manual checks always run; automatic checks respect the user's toggle.
      const runCheck = async (manual = false) => {
        try {
          if (!manual) {
            const enabled = (await backendStore.getMeta('auto_update_check')) !== 'false';
            if (!enabled) return;
          }
          await autoUpdater.checkForUpdates();
        } catch (e) {
          status('error', { message: ((e && e.message) || 'check failed').slice(0, 120) });
        }
      };
      triggerUpdateCheck = runCheck;

      runCheck(false);                                         // on launch
      setInterval(() => runCheck(false), 6 * 60 * 60 * 1000);  // every 6 hours
    } catch (e) {
      console.warn('[AutoUpdate] Failed to initialize:', e.message);
    }
  }
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
