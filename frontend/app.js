/**
 * DecentraNet Browser Frontend
 *
 * - WebSocket client connecting to local Node.js backend
 * - Chat UI (DMs, groups, file sharing)
 * - WebRTC voice/video calls using native browser APIs
 * - Theme system with presets and customization
 * - Generative avatars from peer IDs
 * - Bento-box profile pages
 * - Peer discovery & friend requests
 * - Global timeline with posts, likes, comments
 */

// ─── State ──────────────────────────────────────────────────────────────────

const state = {
  ws: null,
  myPeerId: null,
  myName: null,
  connected: false,
  contacts: [],
  conversations: [],
  groups: [],
  activeChat: null,       // { type: 'dm'|'group', id: conversationId, peerId?, groupId?, name }
  activeView: 'feed',     // 'feed' | 'chat' | 'profile'
  messages: [],
  pendingRequests: {},     // id -> { resolve, reject }
  receivedFiles: {},       // contentId -> fileInfo
  // WebRTC
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  callState: null,
  callPeerId: null,
  callPeerName: null,
  callType: null,
  callTimer: null,
  callStartTime: null,
  iceCandidateQueue: [],
  pendingOffer: null,
  // Theme
  themePrefs: null,
  // Profile
  myProfile: null,
  // Feed
  feedPosts: [],
  // Attachments for new post
  postAttachments: [],
  // Voicenote
  vnRecorder: null,
  vnChunks: [],
  vnBlob: null,
  vnDuration: 0,
  vnStartTime: 0,
  // Audio playback
  currentAudio: null,
  currentAudioUrl: null,
  currentAudioContentId: null,
  vnPlaybackAnim: null,
  // Comments
  commentPostId: null,
  // Avatar cache
  avatarCache: {},
};

// ─── Theme Presets ──────────────────────────────────────────────────────────

const THEME_PRESETS = [
  { id: 'default', name: 'Midnight Dark', vars: { bgPrimary:'#0d1117', bgSecondary:'#161b22', bgTertiary:'#21262d', bgHover:'#30363d', bgActive:'#1f6feb22', border:'#30363d', textPrimary:'#e6edf3', textSecondary:'#8b949e', textMuted:'#484f58', accent:'#58a6ff', accentHover:'#79c0ff', green:'#3fb950', red:'#f85149', orange:'#d29922', msgSent:'#1a3a5c', msgReceived:'#21262d', radius:'8px', radiusLg:'12px' }},
  { id: 'cyberpunk', name: 'Cyberpunk Neon', vars: { bgPrimary:'#0a0014', bgSecondary:'#120020', bgTertiary:'#1a0030', bgHover:'#2a0050', bgActive:'#ff00ff22', border:'#3a0060', textPrimary:'#f0e0ff', textSecondary:'#b080d0', textMuted:'#6a3090', accent:'#ff00ff', accentHover:'#ff44ff', green:'#00ff88', red:'#ff2040', orange:'#ffaa00', msgSent:'#3a0060', msgReceived:'#1a0030', radius:'2px', radiusLg:'4px' }},
  { id: 'vaporwave', name: 'Vaporwave', vars: { bgPrimary:'#1a0033', bgSecondary:'#220044', bgTertiary:'#2a0055', bgHover:'#3a0077', bgActive:'#ff71ce22', border:'#4a0088', textPrimary:'#ffe6ff', textSecondary:'#cc99dd', textMuted:'#7744aa', accent:'#ff71ce', accentHover:'#ff99dd', green:'#01cdfe', red:'#ff6e67', orange:'#ffd700', msgSent:'#4a0088', msgReceived:'#2a0055', radius:'8px', radiusLg:'12px' }},
  { id: 'forest', name: 'Forest', vars: { bgPrimary:'#0b1a0b', bgSecondary:'#112211', bgTertiary:'#1a331a', bgHover:'#224422', bgActive:'#22cc5522', border:'#2a442a', textPrimary:'#d0f0d0', textSecondary:'#88bb88', textMuted:'#446644', accent:'#22cc55', accentHover:'#44dd77', green:'#44ee66', red:'#ee4444', orange:'#ccaa22', msgSent:'#1a4422', msgReceived:'#1a331a', radius:'8px', radiusLg:'12px' }},
  { id: 'ocean', name: 'Ocean Depths', vars: { bgPrimary:'#0a1628', bgSecondary:'#0d1e33', bgTertiary:'#132840', bgHover:'#1a3555', bgActive:'#0099ff22', border:'#1a3555', textPrimary:'#d0e8ff', textSecondary:'#7799bb', textMuted:'#3a5577', accent:'#0099ff', accentHover:'#33aaff', green:'#00cc88', red:'#ff4466', orange:'#ffaa33', msgSent:'#0d3366', msgReceived:'#132840', radius:'8px', radiusLg:'12px' }},
  { id: 'light', name: 'Minimal Light', vars: { bgPrimary:'#ffffff', bgSecondary:'#f6f8fa', bgTertiary:'#eef1f5', bgHover:'#e2e6ea', bgActive:'#0969da22', border:'#d0d7de', textPrimary:'#1f2328', textSecondary:'#656d76', textMuted:'#8b949e', accent:'#0969da', accentHover:'#0c7eeb', green:'#1a7f37', red:'#cf222e', orange:'#bf8700', msgSent:'#ddf4ff', msgReceived:'#f6f8fa', radius:'8px', radiusLg:'12px' }},
  { id: 'sunset', name: 'Sunset', vars: { bgPrimary:'#1a0a0a', bgSecondary:'#221111', bgTertiary:'#2d1818', bgHover:'#442222', bgActive:'#ff660022', border:'#3d2222', textPrimary:'#ffe8d8', textSecondary:'#cc9988', textMuted:'#885544', accent:'#ff6600', accentHover:'#ff8833', green:'#44cc44', red:'#ff3333', orange:'#ffcc00', msgSent:'#442200', msgReceived:'#2d1818', radius:'8px', radiusLg:'12px' }},
  { id: 'terminal', name: 'Hacker', vars: { bgPrimary:'#000000', bgSecondary:'#0a0a0a', bgTertiary:'#111111', bgHover:'#1a1a1a', bgActive:'#00ff0022', border:'#222222', textPrimary:'#00ff00', textSecondary:'#00bb00', textMuted:'#006600', accent:'#00ff00', accentHover:'#33ff33', green:'#00ff00', red:'#ff0000', orange:'#ffff00', msgSent:'#002200', msgReceived:'#111111', radius:'0px', radiusLg:'0px' }},
];

// ─── Theme Engine ───────────────────────────────────────────────────────────

function applyTheme(prefs) {
  if (!prefs) return;
  const preset = THEME_PRESETS.find(p => p.id === prefs.presetId) || THEME_PRESETS[0];
  const vars = { ...preset.vars, ...(prefs.customOverrides || {}) };

  // Apply CSS custom properties
  const root = document.documentElement;
  root.style.setProperty('--bg-primary', vars.bgPrimary);
  root.style.setProperty('--bg-secondary', vars.bgSecondary);
  root.style.setProperty('--bg-tertiary', vars.bgTertiary);
  root.style.setProperty('--bg-hover', vars.bgHover);
  root.style.setProperty('--bg-active', vars.bgActive);
  root.style.setProperty('--border', vars.border);
  root.style.setProperty('--text-primary', vars.textPrimary);
  root.style.setProperty('--text-secondary', vars.textSecondary);
  root.style.setProperty('--text-muted', vars.textMuted);
  root.style.setProperty('--accent', vars.accent);
  root.style.setProperty('--accent-hover', vars.accentHover);
  root.style.setProperty('--green', vars.green);
  root.style.setProperty('--red', vars.red);
  root.style.setProperty('--orange', vars.orange);
  root.style.setProperty('--msg-sent', vars.msgSent);
  root.style.setProperty('--msg-received', vars.msgReceived);
  root.style.setProperty('--radius', vars.radius);
  root.style.setProperty('--radius-lg', vars.radiusLg);

  // Font size
  if (prefs.fontSize) {
    document.body.style.fontSize = prefs.fontSize + 'px';
  }

  // Font family
  if (prefs.fontFamily) {
    document.body.style.fontFamily = prefs.fontFamily;
  }

  // Bubble style
  document.body.classList.remove('bubble-modern', 'bubble-classic', 'bubble-minimal', 'bubble-rounded');
  if (prefs.bubbleStyle && prefs.bubbleStyle !== 'modern') {
    document.body.classList.add('bubble-' + prefs.bubbleStyle);
  }

  // Background
  if (prefs.background) {
    const bg = prefs.background;
    if (bg.mode === 'gradient' && bg.colors && bg.colors.length >= 2) {
      document.body.style.backgroundImage = `linear-gradient(${bg.angle || 135}deg, ${bg.colors[0]}, ${bg.colors[1]})`;
      document.body.style.backgroundColor = '';
    } else if (bg.mode === 'pattern' && bg.patternType) {
      document.body.className = document.body.className.replace(/bg-pattern-\S+/g, '');
      document.body.classList.add('bg-pattern-' + bg.patternType);
      document.body.style.backgroundImage = '';
    } else {
      document.body.style.backgroundImage = '';
      document.body.className = document.body.className.replace(/bg-pattern-\S+/g, '');
    }
  } else {
    document.body.style.backgroundImage = '';
    document.body.className = document.body.className.replace(/bg-pattern-\S+/g, '');
  }

  // Cache in localStorage for flash prevention
  try { localStorage.setItem('decentra_theme', JSON.stringify(prefs)); } catch {}
}

// Apply cached theme immediately to prevent flash
try {
  const cached = localStorage.getItem('decentra_theme');
  if (cached) applyTheme(JSON.parse(cached));
} catch {}

// ─── Generative Avatar ──────────────────────────────────────────────────────

function generateAvatar(peerId, canvas, size) {
  if (!canvas || !peerId) return;
  const ctx = canvas.getContext('2d');
  const s = size || canvas.width;
  canvas.width = s;
  canvas.height = s;

  // Hash the peerId to get deterministic values
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = ((hash << 5) - hash + peerId.charCodeAt(i)) | 0;
  }
  const abs = Math.abs(hash);

  // Extract 3 colors from hash
  const hue1 = abs % 360;
  const hue2 = (abs * 7 + 120) % 360;
  const hue3 = (abs * 13 + 240) % 360;
  const c1 = `hsl(${hue1}, 70%, 55%)`;
  const c2 = `hsl(${hue2}, 65%, 50%)`;
  const c3 = `hsl(${hue3}, 60%, 45%)`;

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, s, s);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);

  // Pattern type from hash
  const patternType = abs % 5;
  const complexity = 3 + (abs % 4);
  const symmetry = 2 + (abs % 3);

  ctx.fillStyle = c3;
  ctx.globalAlpha = 0.4;

  const half = s / 2;

  if (patternType === 0) {
    // Circles
    for (let i = 0; i < complexity; i++) {
      const x = ((abs * (i + 1) * 37) % s);
      const r = 4 + ((abs * (i + 3)) % (s / 4));
      ctx.beginPath();
      ctx.arc(x % half, ((abs * (i + 7) * 23) % s), r, 0, Math.PI * 2);
      ctx.fill();
      // Mirror
      ctx.beginPath();
      ctx.arc(s - (x % half), ((abs * (i + 7) * 23) % s), r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (patternType === 1) {
    // Diamonds
    for (let i = 0; i < complexity; i++) {
      const x = ((abs * (i + 2) * 41) % half);
      const y = ((abs * (i + 5) * 29) % s);
      const sz = 6 + ((abs * (i + 1)) % (s / 5));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
      ctx.restore();
      // Mirror
      ctx.save();
      ctx.translate(s - x, y);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }
  } else if (patternType === 2) {
    // Waves
    ctx.lineWidth = 2;
    ctx.strokeStyle = c3;
    for (let i = 0; i < complexity; i++) {
      ctx.beginPath();
      const yOff = (s / (complexity + 1)) * (i + 1);
      for (let x = 0; x <= s; x += 2) {
        const y = yOff + Math.sin((x / s) * Math.PI * symmetry + i) * (s / 8);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (patternType === 3) {
    // Triangles
    for (let i = 0; i < complexity; i++) {
      const x = ((abs * (i + 3) * 31) % half);
      const y = ((abs * (i + 6) * 17) % s);
      const sz = 8 + ((abs * (i + 2)) % (s / 4));
      ctx.beginPath();
      ctx.moveTo(x, y - sz / 2);
      ctx.lineTo(x - sz / 2, y + sz / 2);
      ctx.lineTo(x + sz / 2, y + sz / 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s - x, y - sz / 2);
      ctx.lineTo(s - x - sz / 2, y + sz / 2);
      ctx.lineTo(s - x + sz / 2, y + sz / 2);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // Hexagons
    for (let i = 0; i < complexity; i++) {
      const x = ((abs * (i + 4) * 43) % half);
      const y = ((abs * (i + 8) * 19) % s);
      const r = 6 + ((abs * (i + 1)) % (s / 5));
      drawHexagon(ctx, x, y, r);
      drawHexagon(ctx, s - x, y, r);
    }
  }

  ctx.globalAlpha = 1;
}

function drawHexagon(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function getAvatarDataURL(peerId, size) {
  const key = peerId + ':' + size;
  if (state.avatarCache[key]) return state.avatarCache[key];
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  generateAvatar(peerId, c, size);
  const url = c.toDataURL();
  state.avatarCache[key] = url;
  return url;
}

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connectWS() {
  const wsUrl = `ws://${window.location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    const token = window.__DECENTRA_TOKEN || '';
    state.ws.send(JSON.stringify({ type: 'auth', token }));
  };

  let authDone = false;
  const origOnMessage = (event) => {
    if (!authDone) {
      const msg = JSON.parse(event.data);
      if (msg.type === 'auth') {
        if (msg.ok) {
          authDone = true;
          state.ws.onmessage = handleWSMessage;
          onAuthenticated();
        } else {
          console.error('WebSocket auth failed');
          setConnectionStatus('offline');
        }
        return;
      }
    }
  };
  state.ws.onmessage = origOnMessage;

  function onAuthenticated() {
    setConnectionStatus('online');
    send('get_identity').then((data) => {
      state.myPeerId = data.peerId;
      state.myName = data.displayName;
      document.getElementById('my-name').textContent = data.displayName || 'Anonymous';
      document.getElementById('my-id').textContent = data.peerId;
      generateAvatar(data.peerId, document.getElementById('my-avatar'), 36);
      generateAvatar(data.peerId, document.getElementById('composer-avatar'), 36);
    });
    send('get_account_status').then((status) => {
      if (status.mode === 'legacy') showMnemonicModal();
    });
    // Load theme from backend
    send('get_theme').then((prefs) => {
      if (prefs) {
        state.themePrefs = prefs;
        applyTheme(prefs);
      }
    });
    refreshAll();
    loadFeed();
  }

  state.ws.onclose = () => {
    setConnectionStatus('offline');
    state.connected = false;
    setTimeout(connectWS, 3000);
  };

  state.ws.onerror = () => {};
}

function handleWSMessage(event) {
  const msg = JSON.parse(event.data);

  if (msg.type === 'response' && state.pendingRequests[msg.id]) {
    const { resolve, reject } = state.pendingRequests[msg.id];
    delete state.pendingRequests[msg.id];
    msg.ok ? resolve(msg.data) : reject(new Error(msg.error));
    return;
  }

  if (msg.type === 'event') {
    handleEvent(msg.event, msg.data);
  }
}

function send(action, data) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    state.pendingRequests[id] = { resolve, reject };
    state.ws.send(JSON.stringify({ type: 'request', id, action, data }));
    setTimeout(() => {
      if (state.pendingRequests[id]) {
        delete state.pendingRequests[id];
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

// ─── Event Handling ─────────────────────────────────────────────────────────

function handleEvent(event, data) {
  switch (event) {
    case 'message': onIncomingMessage(data); break;
    case 'group_message': onIncomingGroupMessage(data); break;
    case 'peer_online':
      showToast(`${data.displayName || 'Peer'} is online`, data.peerId);
      refreshContacts();
      refreshConversations();
      break;
    case 'peer_offline':
      showToast(`${data.displayName || 'Peer'} went offline`);
      refreshContacts();
      break;
    case 'file_received': onFileReceived(data); break;
    case 'call_signal': onCallSignal(data); break;
    case 'key_changed': onKeyChanged(data); break;
    case 'new_post':
      state.feedPosts.unshift(data);
      if (state.activeView === 'feed') renderFeed();
      showToast(`${data.authorName || 'Someone'} posted`, data.content.slice(0, 40));
      break;
    case 'post_interaction':
      if (state.activeView === 'feed') loadFeed();
      break;
    case 'friend_request':
      showToast('Friend request received!', data.fromName);
      loadFriendRequests();
      break;
  }
}

function onIncomingMessage(data) {
  const convoId = [state.myPeerId, data.from].sort().join(':');
  if (state.activeChat && state.activeChat.id === convoId) {
    appendMessage({ from: data.from, body: data.body, timestamp: data.timestamp, status: 'delivered' });
  }
  showToast(`${data.fromName}: ${data.body.slice(0, 50)}`);
  refreshConversations();
}

function onIncomingGroupMessage(data) {
  const convoId = `group:${data.groupId}`;
  if (state.activeChat && state.activeChat.id === convoId) {
    appendMessage({ from: data.from, fromName: data.fromName, body: data.body, timestamp: data.timestamp, status: 'delivered' });
  }
  showToast(`[${data.groupName}] ${data.fromName}: ${data.body.slice(0, 40)}`);
  refreshConversations();
}

function onFileReceived(data) {
  state.receivedFiles[data.fileInfo.contentId] = data.fileInfo;
  const convoId = [state.myPeerId, data.from].sort().join(':');
  if (state.activeChat && state.activeChat.id === convoId) {
    appendFileMessage(data.from, data.fromName, data.fileInfo, data.timestamp);
  }
  showToast(`${data.fromName} shared a file`, `${data.fileInfo.fileName} (${formatBytes(data.fileInfo.fileSize)})`);
  refreshConversations();
}

// ─── Data Refresh ───────────────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([refreshContacts(), refreshConversations(), refreshGroups()]);
}

async function refreshContacts() {
  try { state.contacts = await send('get_contacts'); renderContacts(); } catch (e) { console.error('Failed to refresh contacts:', e); }
}

async function refreshConversations() {
  try { state.conversations = await send('get_conversations'); renderConversations(); } catch (e) { console.error('Failed to refresh conversations:', e); }
}

async function refreshGroups() {
  try { state.groups = await send('get_groups'); renderGroups(); } catch (e) { console.error('Failed to refresh groups:', e); }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderConversations() {
  const el = document.getElementById('conversations-list');
  if (state.conversations.length === 0) {
    el.innerHTML = '<div class="list-item"><span class="subtle">No conversations yet</span></div>';
    return;
  }
  el.innerHTML = state.conversations.map((c) => {
    const isActive = state.activeChat && state.activeChat.id === c.conversationId;
    const time = formatTime(c.lastMessage.timestamp);
    const preview = c.lastMessage.body.slice(0, 40);
    const icon = c.isGroup ? '&#128101; ' : '';
    return `
      <div class="list-item ${isActive ? 'active' : ''}"
           onclick="openConversation('${c.conversationId}', '${escapeHtml(c.displayName)}', ${c.isGroup})">
        <div class="item-name">${icon}${escapeHtml(c.displayName)} <span class="item-time">${time}</span></div>
        <div class="item-preview">${escapeHtml(preview)}</div>
      </div>`;
  }).join('');
}

function renderContacts() {
  const el = document.getElementById('contacts-list');
  if (state.contacts.length === 0) {
    el.innerHTML = '<div class="list-item"><span class="subtle">No contacts yet. Connect a peer!</span></div>';
    return;
  }
  el.innerHTML = state.contacts.map((c) => `
    <div class="list-item" onclick="startDM('${c.peerId}', '${escapeHtml(c.displayName || c.peerId.slice(0, 12))}')">
      <div class="item-name">
        ${c.online ? '<span class="online-dot"></span>' : ''}
        ${escapeHtml(c.displayName || c.peerId.slice(0, 12))}
      </div>
      <div class="item-preview">${c.peerId.slice(0, 20)}...</div>
    </div>`
  ).join('');
}

function renderGroups() {
  const el = document.getElementById('groups-list');
  if (state.groups.length === 0) {
    el.innerHTML = '<div class="list-item"><span class="subtle">No groups yet</span></div>';
    return;
  }
  el.innerHTML = state.groups.map((g) => `
    <div class="list-item" onclick="openGroup('${g.groupId}', '${escapeHtml(g.name)}')">
      <div class="item-name">&#128101; ${escapeHtml(g.name)}</div>
      <div class="item-preview">${g.memberCount} members</div>
    </div>`
  ).join('');
}

function renderMessages(messages) {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  let lastDate = '';
  for (const m of messages) {
    const date = new Date(m.timestamp).toLocaleDateString();
    if (date !== lastDate) { lastDate = date; el.innerHTML += `<div class="date-separator">${date}</div>`; }
    const isMine = m.from === state.myPeerId;
    const time = formatTime(m.timestamp);
    if (m.type === 'file') {
      try {
        const fileInfo = JSON.parse(m.body);
        state.receivedFiles[fileInfo.contentId] = fileInfo;
        el.innerHTML += renderFileMessageHTML(isMine, '', fileInfo, time);
        continue;
      } catch {}
    }
    let senderHTML = '';
    if (!isMine && state.activeChat && state.activeChat.type === 'group') {
      const contact = state.contacts.find((c) => c.peerId === m.from);
      const name = contact?.displayName || m.from.slice(0, 12);
      senderHTML = `<div class="msg-sender">${escapeHtml(name)}</div>`;
    }
    // Check for voicenote message
    const vnMsg = tryParseVoicenoteMsg(m.body);
    if (vnMsg) {
      // Cache the blob data for playback
      if (vnMsg.data) vnBlobCache.set(vnMsg.contentId, dataUrlToBlob(vnMsg.data));
      m.voicenote = vnMsg;
      state.messages.push(m);
      el.innerHTML += renderVoicenoteMessageHTML(isMine, vnMsg, time, senderHTML);
      continue;
    }
    el.innerHTML += `
      <div class="message ${isMine ? 'sent' : 'received'}">
        ${senderHTML}
        <div class="msg-body">${escapeHtml(m.body)}</div>
        <div class="msg-time">${time} ${isMine ? `<span class="msg-status">${m.status || ''}</span>` : ''}</div>
      </div>`;
  }
  // Draw voicenote waveforms after DOM is ready
  requestAnimationFrame(() => {
    el.querySelectorAll('canvas.vn-waveform-display').forEach(c => {
      try { drawPostWaveform(c, JSON.parse(c.dataset.waveform), 0); } catch (e) {}
    });
  });
  scrollToBottom();
}

function appendMessage(msg) {
  const el = document.getElementById('messages');
  const isMine = msg.from === state.myPeerId;
  const time = formatTime(msg.timestamp);
  let senderHTML = '';
  if (!isMine && state.activeChat && state.activeChat.type === 'group') {
    const name = msg.fromName || msg.from.slice(0, 12);
    senderHTML = `<div class="msg-sender">${escapeHtml(name)}</div>`;
  }
  // Check for voicenote
  const vnMsg = tryParseVoicenoteMsg(msg.body);
  if (vnMsg) {
    if (vnMsg.data) vnBlobCache.set(vnMsg.contentId, dataUrlToBlob(vnMsg.data));
    msg.voicenote = vnMsg;
    appendVoicenoteMessage(msg, true);
    return;
  }
  el.innerHTML += `
    <div class="message ${isMine ? 'sent' : 'received'}">
      ${senderHTML}
      <div class="msg-body">${escapeHtml(msg.body)}</div>
      <div class="msg-time">${time}</div>
    </div>`;
  scrollToBottom();
}

function renderFileMessageHTML(isMine, senderName, fileInfo, time) {
  return `
    <div class="message ${isMine ? 'sent' : 'received'} file-message">
      <div class="msg-body">
        &#128206; <strong>${escapeHtml(fileInfo.fileName)}</strong><br>
        <span class="subtle">${formatBytes(fileInfo.fileSize)}</span>
        ${!isMine ? `<br><button class="file-download-btn" onclick="downloadFile('${fileInfo.contentId}')">Download</button>` : ''}
      </div>
      <div class="msg-time">${time}</div>
    </div>`;
}

function appendFileMessage(from, fromName, fileInfo, timestamp) {
  const el = document.getElementById('messages');
  const isMine = from === state.myPeerId;
  const time = formatTime(timestamp);
  el.innerHTML += renderFileMessageHTML(isMine, fromName, fileInfo, time);
  scrollToBottom();
}

// ─── View Management ─────────────────────────────────────────────────────────

function showView(view) {
  state.activeView = view;
  document.getElementById('feed-view').classList.toggle('hidden', view !== 'feed');
  document.getElementById('active-chat').classList.toggle('hidden', view !== 'chat');
  document.getElementById('empty-state').classList.toggle('hidden', view !== 'empty');
  document.getElementById('profile-view').classList.toggle('hidden', view !== 'profile');
}

// ─── Chat Navigation ────────────────────────────────────────────────────────

async function openConversation(conversationId, displayName, isGroup) {
  const type = isGroup ? 'group' : 'dm';
  let peerId = null, groupId = null;
  if (isGroup) { groupId = conversationId.replace('group:', ''); }
  else { const parts = conversationId.split(':'); peerId = parts.find((p) => p !== state.myPeerId) || parts[0]; }
  state.activeChat = { type, id: conversationId, peerId, groupId, name: displayName };
  showView('chat');
  document.getElementById('chat-peer-name').textContent = displayName;
  document.getElementById('chat-peer-name').onclick = () => { if (peerId) openPeerProfile(peerId); };
  const callBtns = document.getElementById('chat-actions');
  callBtns.style.display = type === 'dm' ? 'flex' : 'none';
  document.querySelectorAll('.list-item').forEach((el) => el.classList.remove('active'));
  try {
    const messages = await send('get_history', { conversationId, limit: 100 });
    state.messages = messages;
    renderMessages(messages);
  } catch (e) { console.error('Failed to load history:', e); }
}

function startDM(peerId, displayName) {
  const conversationId = [state.myPeerId, peerId].sort().join(':');
  openConversation(conversationId, displayName, false);
  switchTab('chats');
}

function openGroup(groupId, name) {
  const conversationId = `group:${groupId}`;
  openConversation(conversationId, name, true);
  switchTab('chats');
}

// ─── Sending Messages ───────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !state.activeChat) return;
  input.value = '';
  try {
    if (state.activeChat.type === 'dm') await send('send_message', { to: state.activeChat.peerId, text });
    else await send('send_group_message', { groupId: state.activeChat.groupId, text });
    appendMessage({ from: state.myPeerId, body: text, timestamp: Date.now(), status: 'sent' });
    refreshConversations();
  } catch (e) { showToast('Failed to send message', e.message); }
}

// ─── File Sharing ───────────────────────────────────────────────────────────

function triggerFileShare() {
  if (!state.activeChat || state.activeChat.type !== 'dm') return;
  document.getElementById('file-input').click();
}

async function handleFileSelected(event) {
  const file = event.target.files[0];
  if (!file || !state.activeChat) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = btoa(new Uint8Array(reader.result).reduce((data, byte) => data + String.fromCharCode(byte), ''));
    try {
      showToast('Sharing file...', file.name);
      await send('share_file', { recipientId: state.activeChat.peerId, fileName: file.name, fileData: base64 });
      showToast('File shared!', file.name);
      refreshConversations();
    } catch (e) { showToast('Failed to share file', e.message); }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

async function downloadFile(contentId) {
  const fileInfo = state.receivedFiles[contentId];
  if (!fileInfo) { showToast('File info not found'); return; }
  try {
    showToast('Downloading...', fileInfo.fileName);
    const result = await send('download_file', { fileInfo });
    const binary = atob(result.fileData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = result.fileName; a.click();
    URL.revokeObjectURL(url);
    showToast('Downloaded!', result.fileName);
  } catch (e) { showToast('Download failed', e.message); }
}

// ─── Group Creation ─────────────────────────────────────────────────────────

function showGroupModal() {
  const modal = document.getElementById('group-modal');
  const membersList = document.getElementById('group-members-list');
  membersList.innerHTML = state.contacts.map((c) => `
    <label class="member-option"><input type="checkbox" value="${c.peerId}"> ${escapeHtml(c.displayName || c.peerId.slice(0, 16))}</label>`
  ).join('');
  document.getElementById('group-name-input').value = '';
  modal.classList.remove('hidden');
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) return;
  const checked = document.querySelectorAll('#group-members-list input:checked');
  const members = Array.from(checked).map((el) => el.value);
  if (members.length === 0) { showToast('Select at least one member'); return; }
  try {
    const result = await send('create_group', { name, members });
    document.getElementById('group-modal').classList.add('hidden');
    showToast('Group created!', name);
    refreshGroups();
    openGroup(result.groupId, name);
  } catch (e) { showToast('Failed to create group', e.message); }
}

// ─── Connect Peer ───────────────────────────────────────────────────────────

async function showConnectModal() {
  const modal = document.getElementById('connect-modal');
  const display = document.getElementById('invite-code-display');
  display.textContent = 'Loading...';
  modal.classList.remove('hidden');
  try { const result = await send('get_invite_code'); display.textContent = result.code; }
  catch (e) { display.textContent = 'Failed to load invite code'; }
}

async function copyInviteCode() {
  const code = document.getElementById('invite-code-display').textContent;
  if (!code || code === 'Loading...') return;
  try { await navigator.clipboard.writeText(code); showToast('Invite code copied!'); }
  catch { showToast('Select and copy manually (Ctrl+C)'); }
}

async function connectWithInvite() {
  const input = document.getElementById('connect-code-input');
  const code = input.value.trim();
  if (!code) { showToast('Paste an invite code first'); return; }
  try {
    showToast('Connecting...');
    const result = await send('connect_peer', { code });
    showToast('Connected!', result.name || result.peerId);
    input.value = '';
    document.getElementById('connect-modal').classList.add('hidden');
    refreshContacts();
    refreshConversations();
  } catch (e) { showToast('Connection failed', e.message); }
}

// ─── Settings Modal (Phase 1) ───────────────────────────────────────────────

function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  // Render theme presets
  const grid = document.getElementById('theme-presets');
  const currentId = state.themePrefs?.presetId || 'default';
  grid.innerHTML = THEME_PRESETS.map(p => {
    const bg = p.vars.bgPrimary;
    const accent = p.vars.accent;
    return `<button class="theme-preset-btn ${p.id === currentId ? 'active' : ''}" data-preset="${p.id}" onclick="selectPreset('${p.id}')">
      <div class="theme-preview-swatch" style="background:linear-gradient(135deg,${bg},${accent})"></div>
      ${escapeHtml(p.name)}
    </button>`;
  }).join('');

  // Set current values
  const prefs = state.themePrefs || {};
  const preset = THEME_PRESETS.find(p => p.id === (prefs.presetId || 'default')) || THEME_PRESETS[0];
  const vars = { ...preset.vars, ...(prefs.customOverrides || {}) };
  document.getElementById('setting-accent').value = vars.accent.slice(0, 7);
  document.getElementById('setting-msg-sent').value = vars.msgSent.slice(0, 7);
  document.getElementById('setting-font-size').value = prefs.fontSize || 14;
  document.getElementById('font-size-val').textContent = (prefs.fontSize || 14) + 'px';
  document.getElementById('setting-radius').value = parseInt(vars.radius) || 8;
  document.getElementById('radius-val').textContent = (parseInt(vars.radius) || 8) + 'px';
  document.getElementById('setting-bg-mode').value = prefs.background?.mode || 'solid';
  document.getElementById('setting-bg-pattern').value = prefs.background?.patternType || 'dots';
  document.getElementById('setting-bg-pattern').classList.toggle('hidden', (prefs.background?.mode || 'solid') !== 'pattern');

  // Bubble style
  document.querySelectorAll('.bubble-option').forEach(el => {
    el.classList.toggle('active', el.dataset.style === (prefs.bubbleStyle || 'modern'));
  });

  modal.classList.remove('hidden');
}

function selectPreset(id) {
  document.querySelectorAll('.theme-preset-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.preset === id);
  });
  // Preview immediately
  const preset = THEME_PRESETS.find(p => p.id === id);
  if (preset) {
    const prefs = { ...state.themePrefs, presetId: id };
    applyTheme(prefs);
  }
}

async function saveSettings() {
  const presetId = document.querySelector('.theme-preset-btn.active')?.dataset.preset || 'default';
  const accent = document.getElementById('setting-accent').value;
  const msgSent = document.getElementById('setting-msg-sent').value;
  const fontSize = parseInt(document.getElementById('setting-font-size').value);
  const radius = parseInt(document.getElementById('setting-radius').value);
  const bubbleStyle = document.querySelector('.bubble-option.active')?.dataset.style || 'modern';
  const bgMode = document.getElementById('setting-bg-mode').value;
  const patternType = document.getElementById('setting-bg-pattern').value;

  const preset = THEME_PRESETS.find(p => p.id === presetId) || THEME_PRESETS[0];
  const customOverrides = {};
  if (accent !== preset.vars.accent.slice(0, 7)) customOverrides.accent = accent;
  if (msgSent !== preset.vars.msgSent.slice(0, 7)) customOverrides.msgSent = msgSent;
  if (radius + 'px' !== preset.vars.radius) {
    customOverrides.radius = radius + 'px';
    customOverrides.radiusLg = Math.min(radius + 4, 20) + 'px';
  }

  const prefs = {
    presetId,
    customOverrides: Object.keys(customOverrides).length > 0 ? customOverrides : undefined,
    fontSize,
    bubbleStyle,
    background: bgMode !== 'solid' ? {
      mode: bgMode,
      colors: [preset.vars.bgPrimary, preset.vars.accent],
      angle: 135,
      patternType: bgMode === 'pattern' ? patternType : undefined,
    } : undefined,
  };

  state.themePrefs = prefs;
  applyTheme(prefs);

  // Save discoverability
  const discoverable = document.getElementById('setting-discoverable').checked;
  send('set_discoverable', { discoverable }).catch(() => {});

  try { await send('set_theme', prefs); } catch (e) { showToast('Failed to save theme', e.message); }
  document.getElementById('settings-modal').classList.add('hidden');
}

// ─── Profile View (Phase 2) ─────────────────────────────────────────────────

async function openProfile(peerId) {
  const targetId = peerId || state.myPeerId;
  showView('profile');

  try {
    const data = await send('get_profile', { peerId: targetId });
    document.getElementById('btn-edit-profile').classList.toggle('hidden', !data.isSelf);
    renderBentoProfile(data);
  } catch (e) {
    document.getElementById('profile-bento').innerHTML = '<p class="subtle">Failed to load profile</p>';
  }
}

function openPeerProfile(peerId) {
  openProfile(peerId);
}

function closeProfile() {
  if (state.activeChat) showView('chat');
  else showView('feed');
}

function renderBentoProfile(data) {
  const bento = document.getElementById('profile-bento');
  const profile = data.profile || {};
  const cardData = profile.cardData || {};
  const cards = profile.cards || getDefaultCards();
  const enabledCards = cards.filter(c => c.enabled).sort((a, b) => a.order - b.order);
  const peerId = data.peerId;
  const displayName = data.displayName;

  let html = '';
  for (const card of enabledCards) {
    const sizeClass = 'size-' + card.size;
    switch (card.type) {
      case 'identity':
        html += `<div class="bento-card card-identity ${sizeClass}">
          <canvas class="profile-avatar-large" width="80" height="80" data-peerid="${peerId}"></canvas>
          <div class="identity-info">
            <h2>${escapeHtml(displayName)}</h2>
            ${cardData.tagline ? `<div class="tagline">${escapeHtml(cardData.tagline)}</div>` : ''}
            <div class="subtle" style="font-family:monospace;font-size:0.75em;margin-top:4px">${peerId.slice(0, 20)}...</div>
          </div>
        </div>`;
        break;
      case 'vibe':
        if (cardData.vibe) {
          const v = cardData.vibe;
          html += `<div class="bento-card card-vibe ${sizeClass}" style="background:linear-gradient(135deg,${v.gradientStart},${v.gradientEnd})">
            <div class="vibe-emoji">${escapeHtml(v.emoji)}</div>
            <div class="vibe-text">${escapeHtml(v.text)}</div>
          </div>`;
        }
        break;
      case 'about':
        if (cardData.about) {
          const fontClass = cardData.about.fontStyle !== 'sans' ? 'font-' + cardData.about.fontStyle : '';
          html += `<div class="bento-card card-about ${sizeClass}">
            <h4 style="margin-bottom:8px;color:var(--text-secondary)">About</h4>
            <div class="about-text ${fontClass}">${escapeHtml(cardData.about.text)}</div>
          </div>`;
        }
        break;
      case 'now':
        if (cardData.now) {
          html += `<div class="bento-card card-now ${sizeClass}">
            <div class="now-label">Right Now</div>
            <div class="now-text">${escapeHtml(cardData.now.text)}</div>
            <div class="now-time">${relativeTime(cardData.now.updatedAt)}</div>
          </div>`;
        }
        break;
      case 'stats':
        html += `<div class="bento-card card-stats ${sizeClass}">
          <div class="stat-item"><div class="stat-value">${data.friendCount || 0}</div><div class="stat-label">Friends</div></div>
          <div class="stat-item"><div class="stat-value">${data.postCount || 0}</div><div class="stat-label">Posts</div></div>
        </div>`;
        break;
      case 'music':
        if (cardData.music) {
          html += `<div class="bento-card card-music ${sizeClass}">
            <div class="music-emoji">${escapeHtml(cardData.music.emoji || '&#127911;')}</div>
            <div class="music-info">
              <div class="music-title">${escapeHtml(cardData.music.title)}</div>
              <div class="music-artist">${escapeHtml(cardData.music.artist)}</div>
            </div>
          </div>`;
        }
        break;
      case 'connections':
        html += `<div class="bento-card card-connections ${sizeClass}">
          <h4 style="margin-bottom:8px;color:var(--text-secondary)">Connections</h4>
          <div class="connections-avatars" id="connections-avatars-${peerId}"></div>
        </div>`;
        break;
    }
  }

  bento.innerHTML = html;

  // Render avatars after DOM update
  requestAnimationFrame(() => {
    bento.querySelectorAll('canvas[data-peerid]').forEach(c => {
      generateAvatar(c.dataset.peerid, c, parseInt(c.width));
    });
    const connEl = document.getElementById('connections-avatars-' + peerId);
    if (connEl) {
      send('get_friends').then(friends => {
        connEl.innerHTML = friends.slice(0, 12).map(f =>
          `<canvas width="36" height="36" data-peerid="${f.peerId}" title="${escapeHtml(f.displayName)}"></canvas>`
        ).join('');
        connEl.querySelectorAll('canvas').forEach(c => generateAvatar(c.dataset.peerid, c, 36));
      }).catch(() => {});
    }
  });
}

function getDefaultCards() {
  return [
    { type: 'identity', enabled: true, order: 0, size: 'medium' },
    { type: 'vibe', enabled: true, order: 1, size: 'medium' },
    { type: 'about', enabled: true, order: 2, size: 'large' },
    { type: 'now', enabled: true, order: 3, size: 'small' },
    { type: 'stats', enabled: true, order: 4, size: 'small' },
    { type: 'music', enabled: true, order: 5, size: 'small' },
    { type: 'connections', enabled: true, order: 6, size: 'large' },
    { type: 'pinned', enabled: false, order: 7, size: 'medium' },
  ];
}

// ─── Profile Edit (Phase 2) ─────────────────────────────────────────────────

async function showProfileEditModal() {
  const data = await send('get_profile', { peerId: state.myPeerId });
  const profile = data.profile || {};
  const cd = profile.cardData || {};
  const cards = profile.cards || getDefaultCards();

  document.getElementById('edit-tagline').value = cd.tagline || '';
  document.getElementById('edit-vibe-emoji').value = cd.vibe?.emoji || '';
  document.getElementById('edit-vibe-text').value = cd.vibe?.text || '';
  document.getElementById('edit-vibe-grad-start').value = cd.vibe?.gradientStart || '#ff6b6b';
  document.getElementById('edit-vibe-grad-end').value = cd.vibe?.gradientEnd || '#4ecdc4';
  document.getElementById('edit-about-text').value = cd.about?.text || '';
  document.getElementById('edit-about-font').value = cd.about?.fontStyle || 'sans';
  document.getElementById('edit-now-text').value = cd.now?.text || '';
  document.getElementById('edit-music-emoji').value = cd.music?.emoji || '';
  document.getElementById('edit-music-title').value = cd.music?.title || '';
  document.getElementById('edit-music-artist').value = cd.music?.artist || '';

  // Card toggles
  const togglesEl = document.getElementById('card-toggles');
  togglesEl.innerHTML = cards.map(c =>
    `<label><input type="checkbox" data-card="${c.type}" ${c.enabled ? 'checked' : ''}> ${c.type}</label>`
  ).join('');

  document.getElementById('profile-edit-modal').classList.remove('hidden');
}

async function saveProfile() {
  const cards = getDefaultCards().map(c => {
    const checkbox = document.querySelector(`#card-toggles input[data-card="${c.type}"]`);
    return { ...c, enabled: checkbox ? checkbox.checked : c.enabled };
  });

  const cardData = {
    tagline: document.getElementById('edit-tagline').value.trim() || undefined,
    vibe: document.getElementById('edit-vibe-text').value.trim() ? {
      emoji: document.getElementById('edit-vibe-emoji').value || '',
      text: document.getElementById('edit-vibe-text').value.trim(),
      gradientStart: document.getElementById('edit-vibe-grad-start').value,
      gradientEnd: document.getElementById('edit-vibe-grad-end').value,
    } : undefined,
    about: document.getElementById('edit-about-text').value.trim() ? {
      text: document.getElementById('edit-about-text').value.trim(),
      fontStyle: document.getElementById('edit-about-font').value,
    } : undefined,
    now: document.getElementById('edit-now-text').value.trim() ? {
      text: document.getElementById('edit-now-text').value.trim(),
      updatedAt: Date.now(),
    } : undefined,
    music: document.getElementById('edit-music-title').value.trim() ? {
      emoji: document.getElementById('edit-music-emoji').value || '&#127911;',
      title: document.getElementById('edit-music-title').value.trim(),
      artist: document.getElementById('edit-music-artist').value.trim(),
    } : undefined,
  };

  try {
    await send('update_profile', { cards, cardData });
    showToast('Profile saved!');
    document.getElementById('profile-edit-modal').classList.add('hidden');
    openProfile();
  } catch (e) { showToast('Failed to save profile', e.message); }
}

// ─── Discovery & Friends (Phase 3) ──────────────────────────────────────────

async function searchPeers() {
  const term = document.getElementById('discover-search-input').value.trim();
  try {
    const results = await send('search_peers', { searchTerm: term, maxResults: 20 });
    const friendIds = new Set((await send('get_friends')).map(f => f.peerId));
    renderDiscoverResults(results, friendIds);
  } catch (e) { showToast('Search failed', e.message); }
}

function renderDiscoverResults(results, friendIds) {
  const el = document.getElementById('discover-results');
  if (results.length === 0) {
    el.innerHTML = '<div class="list-item"><span class="subtle">No peers found</span></div>';
    return;
  }
  el.innerHTML = results.map(r => {
    const isFriend = friendIds.has(r.peerId);
    return `<div class="discover-card">
      <canvas width="40" height="40" data-peerid="${r.peerId}"></canvas>
      <div class="discover-info">
        <div class="discover-name" onclick="openPeerProfile('${r.peerId}')" style="cursor:pointer">${escapeHtml(r.displayName)}</div>
        <div class="discover-meta">${r.isOnline ? 'Online' : 'Offline'} &middot; ${r.hopDistance} hop${r.hopDistance > 1 ? 's' : ''}</div>
      </div>
      ${isFriend
        ? '<span class="discover-action friend-badge">Friend</span>'
        : `<button class="discover-action" onclick="sendFriendRequest('${r.peerId}')">Add Friend</button>`}
    </div>`;
  }).join('');
  // Render avatars
  requestAnimationFrame(() => {
    el.querySelectorAll('canvas[data-peerid]').forEach(c => generateAvatar(c.dataset.peerid, c, 40));
  });
}

async function sendFriendRequest(peerId) {
  try {
    await send('send_friend_request', { peerId });
    showToast('Friend request sent!');
  } catch (e) { showToast('Failed to send request', e.message); }
}

async function loadFriendRequests() {
  try {
    const requests = await send('get_friend_requests');
    const section = document.getElementById('friend-requests-section');
    const list = document.getElementById('friend-requests-list');
    if (requests.length === 0) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    list.innerHTML = requests.map(r => `
      <div class="friend-req-item">
        <canvas width="32" height="32" data-peerid="${r.from}"></canvas>
        <div class="friend-req-info">
          <div class="friend-req-name">${escapeHtml(r.fromName)}</div>
          ${r.message ? `<div class="friend-req-msg">${escapeHtml(r.message)}</div>` : ''}
        </div>
        <div class="friend-req-actions">
          <button class="btn-accept" onclick="respondFriendRequest('${r.requestId}', true)">Accept</button>
          <button class="btn-reject" onclick="respondFriendRequest('${r.requestId}', false)">Reject</button>
        </div>
      </div>
    `).join('');
    requestAnimationFrame(() => {
      list.querySelectorAll('canvas[data-peerid]').forEach(c => generateAvatar(c.dataset.peerid, c, 32));
    });
  } catch {}
}

async function respondFriendRequest(requestId, accept) {
  try {
    await send('respond_friend_request', { requestId, accept });
    showToast(accept ? 'Friend added!' : 'Request rejected');
    loadFriendRequests();
  } catch (e) { showToast('Failed', e.message); }
}

// ─── Feed & Posts (Phase 4) ─────────────────────────────────────────────────

async function loadFeed() {
  try {
    const posts = await send('get_timeline', { limit: 50 });
    state.feedPosts = posts;
    renderFeed();
  } catch (e) { console.error('Failed to load feed:', e); }
}

function renderFeed() {
  const el = document.getElementById('feed-posts');
  if (state.feedPosts.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:40px"><p class="subtle">No posts yet. Be the first to post!</p></div>';
    return;
  }
  el.innerHTML = state.feedPosts.map(renderPostCard).join('');
  // Render avatars + voicenote waveforms
  requestAnimationFrame(() => {
    el.querySelectorAll('canvas[data-peerid]').forEach(c => generateAvatar(c.dataset.peerid, c, parseInt(c.width)));
    el.querySelectorAll('canvas.vn-waveform-display').forEach(c => {
      try {
        const waveform = JSON.parse(c.dataset.waveform);
        drawPostWaveform(c, waveform, 0);
      } catch (e) {}
    });
  });
}

function renderPostCard(post) {
  const isMe = post.authorId === state.myPeerId;
  const authorName = post.authorName || post.authorId.slice(0, 12);

  let mediaHTML = '';
  if (post.mediaAttachments && post.mediaAttachments.length > 0) {
    const count = Math.min(post.mediaAttachments.length, 4);
    mediaHTML = `<div class="post-media-grid grid-${count}">`;
    for (let i = 0; i < count; i++) {
      const att = post.mediaAttachments[i];
      const imgSrc = att.data || att.thumbnail;
      if (att.type === 'image' && imgSrc) {
        mediaHTML += `<div class="post-media-item"><img src="${imgSrc}" alt=""></div>`;
      } else if (att.type === 'voicenote') {
        const hasData = !!att.data;
        const hasWaveform = att.waveform && att.waveform.length > 0;
        mediaHTML += `<div class="voicenote-player">
          <button class="vn-play-btn" onclick="playVoicenote('${att.contentId}')" ${!hasData ? 'disabled title="No audio data"' : ''}>&#9654;</button>
          ${hasWaveform
            ? `<canvas class="vn-waveform-display" data-contentid="${att.contentId}" data-waveform='${JSON.stringify(att.waveform)}' width="200" height="30"></canvas>`
            : `<div class="vn-bar"></div>`}
          <span class="vn-duration">${att.duration ? formatDuration(att.duration) : '--:--'}</span>
        </div>`;
      } else if (att.type === 'audio' && att.data) {
        mediaHTML += `<div class="voicenote-player">
          <button class="vn-play-btn" onclick="playVoicenote('${att.contentId}')">&#9654;</button>
          <div class="vn-bar"></div>
          <span class="vn-duration">${escapeHtml(att.fileName || 'audio')}</span>
        </div>`;
      } else if (att.type === 'video' && att.data) {
        mediaHTML += `<div class="post-media-item"><video src="${att.data}" controls style="max-width:100%;max-height:300px"></video></div>`;
      } else {
        mediaHTML += `<div class="post-media-item" style="display:flex;align-items:center;justify-content:center">
          <span class="subtle">${att.type}: ${att.fileName || att.contentId.slice(0, 8)}</span>
        </div>`;
      }
    }
    mediaHTML += '</div>';
  }

  return `<div class="post-card" data-postid="${post.postId}">
    <div class="post-card-header">
      <canvas class="post-avatar" width="40" height="40" data-peerid="${post.authorId}" onclick="openPeerProfile('${post.authorId}')"></canvas>
      <div class="post-author-info">
        <div class="post-author-name" onclick="openPeerProfile('${post.authorId}')">${escapeHtml(authorName)}</div>
        <div class="post-time">${relativeTime(post.timestamp)}</div>
      </div>
    </div>
    ${post.content ? `<div class="post-content">${escapeHtml(post.content)}</div>` : ''}
    ${mediaHTML}
    <div class="post-actions">
      <button class="post-action-btn ${post.liked ? 'liked' : ''}" onclick="toggleLike('${post.postId}', ${!!post.liked})">
        ${post.liked ? '&#10084;' : '&#9825;'} ${post.likeCount || 0}
      </button>
      <button class="post-action-btn" onclick="openComments('${post.postId}')">
        &#128172; ${post.commentCount || 0}
      </button>
    </div>
  </div>`;
}

async function createPost() {
  const input = document.getElementById('post-input');
  const content = input.value.trim();
  if (!content && state.postAttachments.length === 0) return;
  if (content.length > 2000) { showToast('Post too long (max 2000 chars)'); return; }

  try {
    await send('create_post', { content, attachments: state.postAttachments });
    input.value = '';
    document.getElementById('char-counter').textContent = '0/2000';
    state.postAttachments = [];
    document.getElementById('composer-attachments').classList.add('hidden');
    document.getElementById('composer-attachments').innerHTML = '';
    loadFeed();
    showToast('Posted!');
  } catch (e) { showToast('Failed to post', e.message); }
}

async function toggleLike(postId, isLiked) {
  try {
    if (isLiked) await send('unlike_post', { postId });
    else await send('like_post', { postId });
    loadFeed();
  } catch (e) { showToast('Failed', e.message); }
}

async function openComments(postId) {
  state.commentPostId = postId;
  const modal = document.getElementById('comments-modal');
  const list = document.getElementById('comments-list');
  list.innerHTML = '<span class="subtle">Loading...</span>';
  document.getElementById('comment-input').value = '';
  modal.classList.remove('hidden');

  try {
    const comments = await send('get_comments', { postId });
    if (comments.length === 0) {
      list.innerHTML = '<p class="subtle" style="padding:12px 0">No comments yet.</p>';
    } else {
      list.innerHTML = comments.map(c => `
        <div class="comment-item">
          <div class="comment-header">
            <span class="comment-author">${escapeHtml(c.authorName || c.authorId.slice(0, 12))}</span>
            <span class="comment-time">${relativeTime(c.timestamp)}</span>
          </div>
          <div class="comment-body">${escapeHtml(c.content)}</div>
        </div>
      `).join('');
    }
  } catch { list.innerHTML = '<p class="subtle">Failed to load comments</p>'; }
}

async function submitComment() {
  if (!state.commentPostId) return;
  const input = document.getElementById('comment-input');
  const content = input.value.trim();
  if (!content) return;
  try {
    await send('comment_post', { postId: state.commentPostId, content });
    input.value = '';
    openComments(state.commentPostId);
    loadFeed();
  } catch (e) { showToast('Failed to comment', e.message); }
}

// ─── Post Media Attachments ─────────────────────────────────────────────────

function triggerPostImage() { document.getElementById('post-image-input').click(); }
function triggerPostVideo() { document.getElementById('post-video-input').click(); }
function triggerPostAudio() { document.getElementById('post-audio-input').click(); }

const INLINE_SIZE_LIMIT = 500 * 1024; // 500KB — inline as base64; above this use shard system

async function handlePostMedia(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    if (file.size <= INLINE_SIZE_LIMIT) {
      // Small file — inline base64
      state.postAttachments.push({
        type,
        contentId: crypto.randomUUID(),
        mimeType: file.type,
        thumbnail: type === 'image' ? dataUrl : undefined,
        data: dataUrl,
        fileName: file.name,
        fileSize: file.size,
      });
      renderAttachments();
    } else {
      // Large file — upload through shard system
      showToast('Uploading...', `Sharding ${file.name}`);
      try {
        const result = await send('upload_media', {
          base64Data: dataUrl,
          fileName: file.name,
          mimeType: file.type,
        });
        state.postAttachments.push({
          type,
          contentId: result.contentId,
          mimeType: file.type,
          thumbnail: type === 'image' ? dataUrl : undefined,
          fileName: file.name,
          fileSize: file.size,
          fileInfo: result.fileInfo, // shard metadata for download
        });
        renderAttachments();
        showToast('Uploaded', file.name);
      } catch (e) { showToast('Upload failed', e.message); }
    }
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function renderAttachments() {
  const el = document.getElementById('composer-attachments');
  if (state.postAttachments.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = state.postAttachments.map((att, i) => {
    if (att.type === 'image' && att.thumbnail) {
      return `<div class="attachment-preview"><img src="${att.thumbnail}"><button class="remove-attachment" onclick="removeAttachment(${i})">x</button></div>`;
    }
    return `<div class="attachment-preview" style="display:flex;align-items:center;justify-content:center;font-size:0.7em;padding:4px">
      ${escapeHtml(att.fileName || att.type)}
      <button class="remove-attachment" onclick="removeAttachment(${i})">x</button>
    </div>`;
  }).join('');
}

function removeAttachment(index) {
  state.postAttachments.splice(index, 1);
  renderAttachments();
}

// ─── Voicenote Recording ────────────────────────────────────────────────────

let vnAudioCtx = null;
let vnAnalyser = null;
let vnAnimFrame = null;
let vnStream = null;
let vnWaveformSamples = []; // amplitude samples captured during recording

// In-memory blob cache for instant playback (avoids base64 round-trip)
const vnBlobCache = new Map(); // contentId -> Blob

/** Pick best supported audio MIME type for recording */
function getRecorderMime() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function toggleVoicenoteRecorder() {
  const el = document.getElementById('voicenote-recorder');
  el.classList.toggle('hidden');
  if (el.classList.contains('hidden') && state.vnRecorder) {
    cancelVoicenote();
  }
}

async function toggleVoicenoteRecord() {
  const btn = document.getElementById('btn-vn-record');
  const statusEl = document.getElementById('vn-status');

  if (!state.vnRecorder) {
    try {
      vnStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getRecorderMime();
      state.vnRecorder = mimeType
        ? new MediaRecorder(vnStream, { mimeType })
        : new MediaRecorder(vnStream);
      state.vnChunks = [];
      state.vnStartTime = Date.now();

      state.vnRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) state.vnChunks.push(e.data);
      };

      state.vnRecorder.onstop = () => {
        const mime = state.vnRecorder?.mimeType || mimeType || 'audio/webm';
        state.vnBlob = new Blob(state.vnChunks, { type: mime });
        state.vnDuration = (Date.now() - state.vnStartTime) / 1000;
        console.log(`[Voicenote] Recorded: ${state.vnBlob.size} bytes, ${state.vnDuration.toFixed(1)}s, type: ${mime}`);

        if (state.vnBlob.size < 100) {
          statusEl.textContent = 'Recording too short, try again';
          state.vnBlob = null;
          return;
        }

        statusEl.textContent = `Recorded (${formatDuration(state.vnDuration)})`;
        document.getElementById('btn-vn-attach').classList.remove('hidden');
        stopRecordingStream();
        stopWaveform();
      };

      // Start audio visualizer
      startWaveform(vnStream);

      // Collect data every 200ms for reliable chunk capture
      state.vnRecorder.start(200);
      btn.textContent = 'Stop';
      btn.className = 'call-btn end';
      statusEl.textContent = 'Recording...';
    } catch (e) { showToast('Mic access denied', e.message); }
  } else {
    if (state.vnRecorder.state === 'recording') {
      state.vnRecorder.stop();
    }
    btn.textContent = 'Record';
    btn.className = 'call-btn accept';
    stopWaveform();
  }
}

function stopRecordingStream() {
  if (vnStream) {
    vnStream.getTracks().forEach(t => t.stop());
    vnStream = null;
  }
}

/** Start drawing live waveform on the recorder canvas + capture amplitude samples */
function startWaveform(stream) {
  const canvas = document.getElementById('vn-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  vnAudioCtx = new AudioContext();
  const source = vnAudioCtx.createMediaStreamSource(stream);
  vnAnalyser = vnAudioCtx.createAnalyser();
  vnAnalyser.fftSize = 256;
  source.connect(vnAnalyser);
  const bufLen = vnAnalyser.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);

  // Reset waveform samples — capture ~60 samples total for the post display
  vnWaveformSamples = [];
  let lastSampleTime = 0;

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c5ce7';

  function draw() {
    vnAnimFrame = requestAnimationFrame(draw);
    if (!vnAnalyser) return;
    vnAnalyser.getByteFrequencyData(dataArr);

    // Capture an amplitude sample every ~100ms (normalized 0-1)
    const now = Date.now();
    if (now - lastSampleTime > 100) {
      let sum = 0;
      for (let i = 0; i < bufLen; i++) sum += dataArr[i];
      vnWaveformSamples.push(Math.min(1, (sum / bufLen) / 180));
      lastSampleTime = now;
    }

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const barCount = Math.min(bufLen, 48);
    const barW = Math.max(2, (w / barCount) - 1);
    const gap = 1;

    for (let i = 0; i < barCount; i++) {
      const val = dataArr[i] / 255;
      const barH = Math.max(2, val * h * 0.9);
      const x = i * (barW + gap);
      const y = (h - barH) / 2;

      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.4 + val * 0.6;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

/** Stop waveform drawing and clean up audio context */
function stopWaveform() {
  if (vnAnimFrame) { cancelAnimationFrame(vnAnimFrame); vnAnimFrame = null; }
  if (vnAudioCtx) { vnAudioCtx.close().catch(() => {}); vnAudioCtx = null; }
  vnAnalyser = null;
  const canvas = document.getElementById('vn-waveform');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Downsample raw amplitude array to a fixed bar count */
function downsampleWaveform(samples, targetBars) {
  if (!samples || samples.length === 0) return Array(targetBars).fill(0.1);
  if (samples.length <= targetBars) {
    // Pad with low values if we have fewer samples
    const padded = [...samples];
    while (padded.length < targetBars) padded.push(0.05);
    return padded;
  }
  const result = [];
  const step = samples.length / targetBars;
  for (let i = 0; i < targetBars; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    result.push(sum / (end - start));
  }
  return result;
}

/** Draw a static waveform on a canvas, with optional playback progress highlight */
function drawPostWaveform(canvas, waveform, progress) {
  if (!canvas || !waveform || waveform.length === 0) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;

  // Handle HiDPI
  if (canvas.dataset.scaled !== '1') {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    canvas.dataset.scaled = '1';
  }

  ctx.clearRect(0, 0, w, h);

  const barCount = waveform.length;
  const gap = 1.5;
  const barW = Math.max(1.5, (w - gap * (barCount - 1)) / barCount);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#58a6ff';
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#484f58';
  const prog = progress || 0;

  for (let i = 0; i < barCount; i++) {
    const val = Math.max(0.08, waveform[i] || 0);
    const barH = Math.max(2, val * h * 0.85);
    const x = i * (barW + gap);
    const y = (h - barH) / 2;
    const fraction = i / barCount;

    ctx.fillStyle = fraction <= prog ? accent : muted;
    ctx.globalAlpha = fraction <= prog ? 0.9 : 0.4;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 1);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function attachVoicenote() {
  if (!state.vnBlob) return;

  const id = crypto.randomUUID();

  // Cache the raw blob for instant local playback
  vnBlobCache.set(id, state.vnBlob);

  // Downsample waveform to ~60 bars for display
  const waveform = downsampleWaveform(vnWaveformSamples, 60);

  // Also convert to data URL for storage/network distribution
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    state.postAttachments.push({
      type: 'voicenote',
      contentId: id,
      mimeType: state.vnBlob.type || 'audio/webm',
      fileName: 'voicenote.webm',
      duration: state.vnDuration || 0,
      data: dataUrl,
      waveform,
    });
    renderAttachments();
    cancelVoicenote();
    document.getElementById('voicenote-recorder').classList.add('hidden');
  };
  reader.readAsDataURL(state.vnBlob);
}

function cancelVoicenote() {
  if (state.vnRecorder && state.vnRecorder.state === 'recording') {
    state.vnRecorder.stop();
  }
  state.vnRecorder = null;
  stopRecordingStream();
  stopWaveform();
  state.vnChunks = [];
  state.vnBlob = null;
  state.vnDuration = 0;
  state.vnStartTime = 0;
  vnWaveformSamples = [];
  document.getElementById('btn-vn-record').textContent = 'Record';
  document.getElementById('btn-vn-record').className = 'call-btn accept';
  document.getElementById('vn-status').textContent = 'Ready';
  document.getElementById('btn-vn-attach').classList.add('hidden');
}

/**
 * Convert a base64 data URL back to a Blob for playback.
 */
function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'audio/webm';
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** Standalone waveform animation loop — uses state.currentAudio so it works for both play and resume */
function startPlaybackAnimation() {
  if (state.vnPlaybackAnim) { cancelAnimationFrame(state.vnPlaybackAnim); state.vnPlaybackAnim = null; }
  const contentId = state.currentAudioContentId;
  if (!contentId || !state.currentAudio) return;

  const canvas = document.querySelector(`canvas.vn-waveform-display[data-contentid="${contentId}"]`);
  let waveform = null;
  if (canvas) { try { waveform = JSON.parse(canvas.dataset.waveform); } catch (e) {} }

  const att = findVoicenoteAttachment(contentId);
  const knownDuration = att?.duration || 0;

  function tick() {
    const audio = state.currentAudio;
    if (!audio || audio.paused || audio.ended) return;
    const dur = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : knownDuration;
    if (canvas && waveform && dur > 0) {
      drawPostWaveform(canvas, waveform, Math.min(1, audio.currentTime / dur));
    }
    state.vnPlaybackAnim = requestAnimationFrame(tick);
  }
  tick();
}

function playVoicenote(contentId) {
  const btn = document.querySelector(`[onclick="playVoicenote('${contentId}')"]`);

  // If this same clip is already playing, toggle pause/resume
  if (state.currentAudio && state.currentAudioContentId === contentId) {
    if (state.currentAudio.paused) {
      state.currentAudio.play().then(() => {
        if (btn) btn.innerHTML = '&#9632;';
        startPlaybackAnimation();
      }).catch(() => {});
    } else {
      state.currentAudio.pause();
      if (state.vnPlaybackAnim) { cancelAnimationFrame(state.vnPlaybackAnim); state.vnPlaybackAnim = null; }
      if (btn) btn.innerHTML = '&#9654;';
    }
    return;
  }

  // Stop any previously playing audio + animation
  if (state.currentAudio) {
    state.currentAudio.pause();
    const prevBtn = document.querySelector(`[onclick="playVoicenote('${state.currentAudioContentId}')"]`);
    if (prevBtn) prevBtn.innerHTML = '&#9654;';
    const prevCanvas = document.querySelector(`canvas.vn-waveform-display[data-contentid="${state.currentAudioContentId}"]`);
    if (prevCanvas) {
      try { drawPostWaveform(prevCanvas, JSON.parse(prevCanvas.dataset.waveform), 0); } catch (e) {}
    }
    if (state.currentAudioUrl) { URL.revokeObjectURL(state.currentAudioUrl); state.currentAudioUrl = null; }
    state.currentAudio = null;
  }
  if (state.vnPlaybackAnim) { cancelAnimationFrame(state.vnPlaybackAnim); state.vnPlaybackAnim = null; }

  // 1. Try cached blob first (instant playback for own recordings)
  let blob = vnBlobCache.get(contentId);

  // 2. Fall back to decoding the data URL from stored posts or chat messages
  if (!blob) {
    const att = findVoicenoteAttachment(contentId);
    if (att && att.data) blob = dataUrlToBlob(att.data);
  }

  if (!blob || blob.size < 100) {
    showToast('Voicenote unavailable', 'Audio data not found');
    return;
  }

  const objUrl = URL.createObjectURL(blob);
  const audio = new Audio(objUrl);
  state.currentAudio = audio;
  state.currentAudioUrl = objUrl;
  state.currentAudioContentId = contentId;

  if (btn) btn.innerHTML = '&#9632;';

  const waveCanvas = document.querySelector(`canvas.vn-waveform-display[data-contentid="${contentId}"]`);

  audio.onended = () => {
    URL.revokeObjectURL(objUrl);
    state.currentAudio = null;
    state.currentAudioUrl = null;
    state.currentAudioContentId = null;
    if (state.vnPlaybackAnim) { cancelAnimationFrame(state.vnPlaybackAnim); state.vnPlaybackAnim = null; }
    if (btn) btn.innerHTML = '&#9654;';
    if (waveCanvas) {
      try { drawPostWaveform(waveCanvas, JSON.parse(waveCanvas.dataset.waveform), 0); } catch (e) {}
    }
  };
  audio.onerror = (e) => {
    console.error('[Voicenote] Playback error:', audio.error);
    audio.onended();
    showToast('Playback failed', audio.error?.message || 'Could not decode audio');
  };
  audio.play().then(() => {
    startPlaybackAnimation();
  }).catch(e => showToast('Playback failed', e.message));
}

/** Try to parse a message body as a voicenote JSON. Returns the voicenote data or null. */
function tryParseVoicenoteMsg(body) {
  if (!body || !body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed.type === 'voicenote' && parsed.voicenote) return parsed.voicenote;
  } catch (e) {}
  return null;
}

/** Find a voicenote/audio attachment by contentId across feed posts and chat messages */
function findVoicenoteAttachment(contentId) {
  // Check feed posts
  for (const post of state.feedPosts) {
    if (!post.mediaAttachments) continue;
    const att = post.mediaAttachments.find(a => a.contentId === contentId);
    if (att) return att;
  }
  // Check chat messages
  for (const m of state.messages) {
    if (m.voicenote && m.voicenote.contentId === contentId) return m.voicenote;
  }
  return null;
}

// ─── Chat Voicenote (DMs & Groups) ──────────────────────────────────────────

let chatVnRecorder = null;
let chatVnChunks = [];
let chatVnBlob = null;
let chatVnDuration = 0;
let chatVnStartTime = 0;
let chatVnStream = null;
let chatVnAudioCtx = null;
let chatVnAnalyser = null;
let chatVnAnimFrame = null;
let chatVnWaveformSamples = [];

function toggleChatVnRecorder() {
  const el = document.getElementById('chat-vn-recorder');
  el.classList.toggle('hidden');
  if (el.classList.contains('hidden') && chatVnRecorder) cancelChatVn();
}

async function toggleChatVnRecord() {
  const btn = document.getElementById('btn-chat-vn-record');
  const statusEl = document.getElementById('chat-vn-status');

  if (!chatVnRecorder) {
    try {
      chatVnStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getRecorderMime();
      chatVnRecorder = mimeType
        ? new MediaRecorder(chatVnStream, { mimeType })
        : new MediaRecorder(chatVnStream);
      chatVnChunks = [];
      chatVnStartTime = Date.now();
      chatVnWaveformSamples = [];

      chatVnRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chatVnChunks.push(e.data);
      };

      chatVnRecorder.onstop = () => {
        const mime = chatVnRecorder?.mimeType || mimeType || 'audio/webm';
        chatVnBlob = new Blob(chatVnChunks, { type: mime });
        chatVnDuration = (Date.now() - chatVnStartTime) / 1000;

        if (chatVnBlob.size < 100) {
          statusEl.textContent = 'Recording too short, try again';
          chatVnBlob = null;
          return;
        }

        statusEl.textContent = `Recorded (${formatDuration(chatVnDuration)})`;
        document.getElementById('btn-chat-vn-send').classList.remove('hidden');
        stopChatVnStream();
        stopChatVnWaveform();
      };

      startChatVnWaveform(chatVnStream);
      chatVnRecorder.start(200);
      btn.textContent = 'Stop';
      btn.className = 'call-btn end';
      statusEl.textContent = 'Recording...';
    } catch (e) { showToast('Mic access denied', e.message); }
  } else {
    if (chatVnRecorder.state === 'recording') chatVnRecorder.stop();
    btn.textContent = 'Record';
    btn.className = 'call-btn accept';
    stopChatVnWaveform();
  }
}

function stopChatVnStream() {
  if (chatVnStream) { chatVnStream.getTracks().forEach(t => t.stop()); chatVnStream = null; }
}

function startChatVnWaveform(stream) {
  const canvas = document.getElementById('chat-vn-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  chatVnAudioCtx = new AudioContext();
  const source = chatVnAudioCtx.createMediaStreamSource(stream);
  chatVnAnalyser = chatVnAudioCtx.createAnalyser();
  chatVnAnalyser.fftSize = 256;
  source.connect(chatVnAnalyser);
  const bufLen = chatVnAnalyser.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);
  chatVnWaveformSamples = [];
  let lastSampleTime = 0;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c5ce7';

  function draw() {
    chatVnAnimFrame = requestAnimationFrame(draw);
    if (!chatVnAnalyser) return;
    chatVnAnalyser.getByteFrequencyData(dataArr);
    const now = Date.now();
    if (now - lastSampleTime > 100) {
      let sum = 0;
      for (let i = 0; i < bufLen; i++) sum += dataArr[i];
      chatVnWaveformSamples.push(Math.min(1, (sum / bufLen) / 180));
      lastSampleTime = now;
    }
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const barCount = Math.min(bufLen, 48);
    const barW = Math.max(2, (w / barCount) - 1);
    for (let i = 0; i < barCount; i++) {
      const val = dataArr[i] / 255;
      const barH = Math.max(2, val * h * 0.9);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.4 + val * 0.6;
      ctx.beginPath();
      ctx.roundRect(i * (barW + 1), (h - barH) / 2, barW, barH, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

function stopChatVnWaveform() {
  if (chatVnAnimFrame) { cancelAnimationFrame(chatVnAnimFrame); chatVnAnimFrame = null; }
  if (chatVnAudioCtx) { chatVnAudioCtx.close().catch(() => {}); chatVnAudioCtx = null; }
  chatVnAnalyser = null;
  const canvas = document.getElementById('chat-vn-waveform');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

async function sendChatVoicenote() {
  if (!chatVnBlob || !state.activeChat) return;

  const id = crypto.randomUUID();
  vnBlobCache.set(id, chatVnBlob);
  const waveform = downsampleWaveform(chatVnWaveformSamples, 60);
  const duration = chatVnDuration;

  // Convert to data URL for transmission
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const vnData = { contentId: id, mimeType: chatVnBlob.type || 'audio/webm', duration, waveform, data: dataUrl };

    // Send as a special message with voicenote JSON body
    const msgBody = JSON.stringify({ type: 'voicenote', voicenote: vnData });
    try {
      if (state.activeChat.type === 'dm') {
        await send('send_message', { to: state.activeChat.peerId, text: msgBody });
      } else {
        await send('send_group_message', { groupId: state.activeChat.groupId, text: msgBody });
      }
      // Show locally
      appendVoicenoteMessage({ from: state.myPeerId, voicenote: vnData, timestamp: Date.now() }, true);
    } catch (e) { showToast('Failed to send voicenote', e.message); }

    cancelChatVn();
    document.getElementById('chat-vn-recorder').classList.add('hidden');
  };
  reader.readAsDataURL(chatVnBlob);
}

function cancelChatVn() {
  if (chatVnRecorder && chatVnRecorder.state === 'recording') chatVnRecorder.stop();
  chatVnRecorder = null;
  stopChatVnStream();
  stopChatVnWaveform();
  chatVnChunks = [];
  chatVnBlob = null;
  chatVnDuration = 0;
  chatVnStartTime = 0;
  chatVnWaveformSamples = [];
  document.getElementById('btn-chat-vn-record').textContent = 'Record';
  document.getElementById('btn-chat-vn-record').className = 'call-btn accept';
  document.getElementById('chat-vn-status').textContent = 'Ready';
  document.getElementById('btn-chat-vn-send').classList.add('hidden');
}

/** Render a voicenote message bubble in the chat */
function renderVoicenoteMessageHTML(isMine, vn, time, senderHTML) {
  const hasWaveform = vn.waveform && vn.waveform.length > 0;
  return `
    <div class="message ${isMine ? 'sent' : 'received'}">
      ${senderHTML || ''}
      <div class="voicenote-player">
        <button class="vn-play-btn" onclick="playVoicenote('${vn.contentId}')">&#9654;</button>
        ${hasWaveform
          ? `<canvas class="vn-waveform-display" data-contentid="${vn.contentId}" data-waveform='${JSON.stringify(vn.waveform)}' width="200" height="30"></canvas>`
          : `<div class="vn-bar"></div>`}
        <span class="vn-duration">${vn.duration ? formatDuration(vn.duration) : '--:--'}</span>
      </div>
      <div class="msg-time">${time}</div>
    </div>`;
}

function appendVoicenoteMessage(msg, scrollDown) {
  const el = document.getElementById('messages');
  const isMine = msg.from === state.myPeerId;
  const time = formatTime(msg.timestamp);
  let senderHTML = '';
  if (!isMine && state.activeChat && state.activeChat.type === 'group') {
    const name = msg.fromName || msg.from.slice(0, 12);
    senderHTML = `<div class="msg-sender">${escapeHtml(name)}</div>`;
  }
  el.innerHTML += renderVoicenoteMessageHTML(isMine, msg.voicenote, time, senderHTML);
  // Draw waveform on new canvas
  requestAnimationFrame(() => {
    const canvas = el.querySelector(`canvas.vn-waveform-display[data-contentid="${msg.voicenote.contentId}"]`);
    if (canvas) {
      try { drawPostWaveform(canvas, JSON.parse(canvas.dataset.waveform), 0); } catch (e) {}
    }
  });
  // Store in messages for findVoicenoteAttachment lookup
  state.messages.push(msg);
  if (scrollDown) scrollToBottom();
}

// ─── WebRTC Voice/Video Calls ───────────────────────────────────────────────

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

async function startCall(type) {
  if (!state.activeChat || state.activeChat.type !== 'dm') return;
  state.callType = type;
  state.callPeerId = state.activeChat.peerId;
  state.callPeerName = state.activeChat.name;
  state.callState = 'calling';
  state.iceCandidateQueue = [];
  showCallUI();
  updateCallStatus('Calling...');
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
    if (type === 'video') {
      document.getElementById('local-video').srcObject = state.localStream;
      document.getElementById('video-container').classList.remove('hidden');
      document.getElementById('btn-toggle-video').classList.remove('hidden');
    }
    createPeerConnection();
    state.localStream.getTracks().forEach((track) => state.peerConnection.addTrack(track, state.localStream));
    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);
    await send('call_signal', { peerId: state.callPeerId, signal: { type: 'offer', sdp: offer.sdp, callType: type } });
  } catch (e) { showToast('Call failed', e.message); endCall(); }
}

function createPeerConnection() {
  state.peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.peerConnection.onicecandidate = (event) => {
    if (event.candidate) send('call_signal', { peerId: state.callPeerId, signal: { type: 'ice-candidate', candidate: event.candidate } }).catch(() => {});
  };
  state.peerConnection.ontrack = (event) => {
    state.remoteStream = event.streams[0];
    document.getElementById('remote-video').srcObject = event.streams[0];
    if (state.callType === 'video') document.getElementById('video-container').classList.remove('hidden');
  };
  state.peerConnection.onconnectionstatechange = () => {
    const cs = state.peerConnection.connectionState;
    if (cs === 'connected') { state.callState = 'connected'; updateCallStatus('Connected'); startCallTimer(); }
    else if (cs === 'disconnected' || cs === 'failed' || cs === 'closed') endCall();
  };
}

async function onCallSignal(data) {
  const signal = data.signal;
  if (signal.type === 'offer') {
    state.callPeerId = data.from; state.callPeerName = data.fromName; state.callType = signal.callType || 'voice'; state.callState = 'incoming'; state.iceCandidateQueue = []; state.pendingOffer = signal;
    showCallUI(); updateCallStatus(`Incoming ${state.callType} call...`);
    document.getElementById('incoming-call-controls').classList.remove('hidden');
    document.getElementById('call-controls').classList.add('hidden');
  } else if (signal.type === 'answer') {
    if (state.peerConnection) {
      await state.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
      for (const c of state.iceCandidateQueue) await state.peerConnection.addIceCandidate(new RTCIceCandidate(c));
      state.iceCandidateQueue = [];
    }
  } else if (signal.type === 'ice-candidate') {
    if (state.peerConnection && state.peerConnection.remoteDescription) await state.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    else state.iceCandidateQueue.push(signal.candidate);
  } else if (signal.type === 'hangup') endCall();
}

function endCall() {
  if (state.callPeerId && state.callState) send('call_signal', { peerId: state.callPeerId, signal: { type: 'hangup' } }).catch(() => {});
  if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }
  if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }
  state.remoteStream = null; state.callState = null; state.callPeerId = null; state.callPeerName = null;
  if (state.callTimer) { clearInterval(state.callTimer); state.callTimer = null; }
  hideCallUI();
}

async function acceptCall() {
  if (!state.pendingOffer || state.callState !== 'incoming') return;
  const signal = state.pendingOffer; state.pendingOffer = null;
  document.getElementById('incoming-call-controls').classList.add('hidden');
  document.getElementById('call-controls').classList.remove('hidden');
  updateCallStatus('Connecting...');
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: state.callType === 'video' });
    if (state.callType === 'video') { document.getElementById('local-video').srcObject = state.localStream; document.getElementById('video-container').classList.remove('hidden'); document.getElementById('btn-toggle-video').classList.remove('hidden'); }
    createPeerConnection();
    state.localStream.getTracks().forEach(track => state.peerConnection.addTrack(track, state.localStream));
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
    for (const c of state.iceCandidateQueue) await state.peerConnection.addIceCandidate(new RTCIceCandidate(c));
    state.iceCandidateQueue = [];
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    await send('call_signal', { peerId: state.callPeerId, signal: { type: 'answer', sdp: answer.sdp } });
  } catch (e) { showToast('Call failed', e.message); endCall(); }
}

function rejectCall() {
  if (state.callPeerId) send('call_signal', { peerId: state.callPeerId, signal: { type: 'hangup' } }).catch(() => {});
  state.pendingOffer = null; state.callState = null; state.callPeerId = null; state.callPeerName = null;
  hideCallUI();
}

function toggleMute() {
  if (!state.localStream) return;
  const t = state.localStream.getAudioTracks()[0];
  if (t) { t.enabled = !t.enabled; document.getElementById('btn-toggle-mute').classList.toggle('active', !t.enabled); document.getElementById('btn-toggle-mute').textContent = t.enabled ? 'Mute' : 'Unmute'; }
}

function toggleVideo() {
  if (!state.localStream) return;
  const t = state.localStream.getVideoTracks()[0];
  if (t) { t.enabled = !t.enabled; document.getElementById('btn-toggle-video').classList.toggle('active', !t.enabled); document.getElementById('btn-toggle-video').textContent = t.enabled ? 'Camera Off' : 'Camera On'; }
}

function showCallUI() {
  document.getElementById('call-panel').classList.remove('hidden');
  document.getElementById('call-peer-name').textContent = state.callPeerName || 'Unknown';
  document.getElementById('call-timer').textContent = '';
  if (state.callState === 'incoming') { document.getElementById('incoming-call-controls').classList.remove('hidden'); document.getElementById('call-controls').classList.add('hidden'); }
  else { document.getElementById('incoming-call-controls').classList.add('hidden'); document.getElementById('call-controls').classList.remove('hidden'); }
  if (state.callType === 'video') { document.getElementById('video-container').classList.remove('hidden'); document.getElementById('btn-toggle-video').classList.remove('hidden'); }
  else { document.getElementById('video-container').classList.add('hidden'); document.getElementById('btn-toggle-video').classList.add('hidden'); }
}

function hideCallUI() {
  document.getElementById('call-panel').classList.add('hidden');
  document.getElementById('video-container').classList.add('hidden');
  document.getElementById('local-video').srcObject = null;
  document.getElementById('remote-video').srcObject = null;
}

function updateCallStatus(text) { document.getElementById('call-status').textContent = text; }

function startCallTimer() {
  state.callStartTime = Date.now();
  state.callTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
    document.getElementById('call-timer').textContent = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  }, 1000);
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tab) tab.classList.add('active');
  const content = document.getElementById(`tab-${tabName}`);
  if (content) content.classList.add('active');

  // Show appropriate main view
  if (tabName === 'feed') { showView('feed'); loadFeed(); }
  else if (tabName === 'discover') { loadFriendRequests(); }
  else if (tabName === 'chats' || tabName === 'contacts' || tabName === 'groups') {
    if (!state.activeChat) showView('empty');
  }
}

function setConnectionStatus(status) {
  const dot = document.getElementById('connection-status');
  dot.className = `status-dot ${status}`;
  state.connected = status === 'online';
}

function scrollToBottom() {
  const container = document.getElementById('messages-container');
  container.scrollTop = container.scrollHeight;
}

function showToast(title, body) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function formatDuration(seconds) {
  const secs = Math.floor(seconds);
  return `${Math.floor(secs / 60).toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Display Name ───────────────────────────────────────────────────────────

function showNameModal() {
  const modal = document.getElementById('name-modal');
  document.getElementById('name-input').value = state.myName || '';
  modal.classList.remove('hidden');
  document.getElementById('name-input').focus();
}

async function saveName() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) return;
  try {
    await send('set_display_name', { name });
    state.myName = name;
    document.getElementById('my-name').textContent = name;
    document.getElementById('name-modal').classList.add('hidden');
    showToast('Name updated', name);
  } catch (e) { showToast('Failed to update name', e.message); }
}

// ─── Mnemonic Setup/Recovery ────────────────────────────────────────────────

let mnemonicWords = null;

function showMnemonicModal() {
  document.getElementById('mnemonic-modal').classList.remove('hidden');
  showMnemonicStep('choose');
}

function showMnemonicStep(step) {
  ['choose', 'display', 'verify', 'recover'].forEach(s => {
    document.getElementById(`mnemonic-step-${s}`).classList.toggle('hidden', s !== step);
  });
}

async function mnemonicCreate() {
  try {
    const result = await send('setup_mnemonic', { displayName: state.myName });
    mnemonicWords = result.mnemonic;
    const grid = document.getElementById('mnemonic-words');
    grid.innerHTML = mnemonicWords.map((word, i) => `<div class="mnemonic-word"><span class="mnemonic-word-num">${i + 1}.</span> ${escapeHtml(word)}</div>`).join('');
    showMnemonicStep('display');
  } catch (e) { showToast('Failed to generate mnemonic', e.message); }
}

function mnemonicShowVerify() {
  showMnemonicStep('verify');
  document.getElementById('verify-word-3').value = '';
  document.getElementById('verify-word-7').value = '';
  document.getElementById('verify-word-11').value = '';
  document.getElementById('verify-error').classList.add('hidden');
}

async function mnemonicVerify() {
  const w3 = document.getElementById('verify-word-3').value.trim().toLowerCase();
  const w7 = document.getElementById('verify-word-7').value.trim().toLowerCase();
  const w11 = document.getElementById('verify-word-11').value.trim().toLowerCase();
  if (w3 !== mnemonicWords[2] || w7 !== mnemonicWords[6] || w11 !== mnemonicWords[10]) {
    const errEl = document.getElementById('verify-error');
    errEl.textContent = 'Words do not match. Please check your backup.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    await send('confirm_mnemonic', { mnemonic: mnemonicWords, displayName: state.myName });
    document.getElementById('mnemonic-modal').classList.add('hidden');
    showToast('Identity created!', 'Your seed phrase is your backup key.');
    mnemonicWords = null;
  } catch (e) { showToast('Failed to confirm', e.message); }
}

function mnemonicShowRecover() {
  showMnemonicStep('recover');
  const grid = document.getElementById('recover-inputs');
  grid.innerHTML = Array.from({ length: 12 }, (_, i) => `<input type="text" id="recover-word-${i}" placeholder="${i + 1}" autocomplete="off">`).join('');
  document.getElementById('recover-error').classList.add('hidden');
}

async function mnemonicRecover() {
  const words = [];
  for (let i = 0; i < 12; i++) {
    const val = document.getElementById(`recover-word-${i}`).value.trim().toLowerCase();
    if (!val) { const errEl = document.getElementById('recover-error'); errEl.textContent = `Word #${i + 1} is empty`; errEl.classList.remove('hidden'); return; }
    words.push(val);
  }
  try {
    const result = await send('recover_mnemonic', { mnemonic: words });
    document.getElementById('mnemonic-modal').classList.add('hidden');
    showToast('Identity recovered!', `Peer ID: ${result.peerId.slice(0, 16)}...`);
    if (result.bundleFound) showToast('Account bundle found!', 'Contacts and groups restored.');
  } catch (e) { const errEl = document.getElementById('recover-error'); errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

// ─── TOFU Key Change Warning ────────────────────────────────────────────────

let tofuPeerId = null;

function onKeyChanged(data) {
  tofuPeerId = data.peerId;
  document.getElementById('tofu-peer-name').textContent = data.displayName || data.peerId.slice(0, 12);
  document.getElementById('tofu-banner').classList.remove('hidden');
}

function tofuAccept() {
  document.getElementById('tofu-banner').classList.add('hidden');
  showToast('Key accepted', `Accepted new key for ${tofuPeerId?.slice(0, 12)}`);
  tofuPeerId = null;
}

function tofuReject() {
  document.getElementById('tofu-banner').classList.add('hidden');
  showToast('Key rejected', 'Peer will not be trusted with the new key.');
  tofuPeerId = null;
}

// ─── Event Bindings ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Send message
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

  // Call buttons
  document.getElementById('btn-voice-call').addEventListener('click', () => startCall('voice'));
  document.getElementById('btn-video-call').addEventListener('click', () => startCall('video'));
  document.getElementById('btn-end-call').addEventListener('click', endCall);
  document.getElementById('btn-accept-call').addEventListener('click', acceptCall);
  document.getElementById('btn-reject-call').addEventListener('click', rejectCall);
  document.getElementById('btn-toggle-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-toggle-video').addEventListener('click', toggleVideo);

  // File sharing
  document.getElementById('btn-share-file').addEventListener('click', triggerFileShare);
  document.getElementById('file-input').addEventListener('change', handleFileSelected);

  // Post media inputs
  document.getElementById('post-image-input').addEventListener('change', (e) => handlePostMedia(e, 'image'));
  document.getElementById('post-video-input').addEventListener('change', (e) => handlePostMedia(e, 'video'));
  document.getElementById('post-audio-input').addEventListener('change', (e) => handlePostMedia(e, 'audio'));

  // Post char counter
  document.getElementById('post-input').addEventListener('input', () => {
    const len = document.getElementById('post-input').value.length;
    document.getElementById('char-counter').textContent = `${len}/2000`;
  });

  // Group creation
  document.getElementById('btn-create-group').addEventListener('click', showGroupModal);
  document.getElementById('btn-cancel-group').addEventListener('click', () => document.getElementById('group-modal').classList.add('hidden'));
  document.getElementById('btn-confirm-group').addEventListener('click', createGroup);

  // Connect peer
  document.getElementById('btn-connect-peer').addEventListener('click', showConnectModal);
  document.getElementById('btn-copy-invite').addEventListener('click', copyInviteCode);
  document.getElementById('btn-connect-invite').addEventListener('click', connectWithInvite);
  document.getElementById('btn-cancel-connect').addEventListener('click', () => document.getElementById('connect-modal').classList.add('hidden'));

  // Name modal
  document.getElementById('btn-cancel-name').addEventListener('click', () => document.getElementById('name-modal').classList.add('hidden'));
  document.getElementById('btn-save-name').addEventListener('click', saveName);
  document.getElementById('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

  // Settings modal
  document.getElementById('btn-cancel-settings').addEventListener('click', () => {
    // Revert theme preview
    if (state.themePrefs) applyTheme(state.themePrefs);
    document.getElementById('settings-modal').classList.add('hidden');
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('setting-font-size').addEventListener('input', (e) => {
    document.getElementById('font-size-val').textContent = e.target.value + 'px';
  });
  document.getElementById('setting-radius').addEventListener('input', (e) => {
    document.getElementById('radius-val').textContent = e.target.value + 'px';
  });
  document.getElementById('setting-bg-mode').addEventListener('change', (e) => {
    document.getElementById('setting-bg-pattern').classList.toggle('hidden', e.target.value !== 'pattern');
  });
  document.querySelectorAll('.bubble-option').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.bubble-option').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    });
  });

  // Profile edit modal
  document.getElementById('btn-cancel-profile-edit').addEventListener('click', () => document.getElementById('profile-edit-modal').classList.add('hidden'));
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);

  // Comments modal
  document.getElementById('btn-close-comments').addEventListener('click', () => document.getElementById('comments-modal').classList.add('hidden'));
  document.getElementById('btn-submit-comment').addEventListener('click', submitComment);
  document.getElementById('comment-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitComment(); });

  // Discover
  document.getElementById('btn-discover-search').addEventListener('click', searchPeers);
  document.getElementById('discover-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchPeers(); });

  // Mnemonic setup
  document.getElementById('btn-mnemonic-create').addEventListener('click', mnemonicCreate);
  document.getElementById('btn-mnemonic-recover').addEventListener('click', mnemonicShowRecover);
  document.getElementById('btn-mnemonic-skip').addEventListener('click', () => document.getElementById('mnemonic-modal').classList.add('hidden'));
  document.getElementById('btn-mnemonic-confirm').addEventListener('click', mnemonicShowVerify);
  document.getElementById('btn-mnemonic-back').addEventListener('click', () => showMnemonicStep('display'));
  document.getElementById('btn-mnemonic-verify').addEventListener('click', mnemonicVerify);
  document.getElementById('btn-recover-back').addEventListener('click', () => showMnemonicStep('choose'));
  document.getElementById('btn-recover-submit').addEventListener('click', mnemonicRecover);

  // TOFU
  document.getElementById('btn-tofu-accept').addEventListener('click', tofuAccept);
  document.getElementById('btn-tofu-reject').addEventListener('click', tofuReject);

  // Connect WebSocket
  connectWS();

  // Periodic refresh
  setInterval(() => {
    if (state.connected) {
      refreshContacts();
      refreshConversations();
    }
  }, 10000);
});
