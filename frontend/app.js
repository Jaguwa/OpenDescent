/**
 * OpenDescent Browser Frontend
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

console.log('[OpenDescent] app.js loaded');

// ─── Debounce Utility ────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ─── Custom Confirm / Prompt Dialogs ─────────────────────────────────────────

function showConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-message').textContent = message;
    modal.classList.remove('hidden');
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    function cleanup(result) {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    ok.focus();
  });
}

function showPrompt(message, defaultValue) {
  return new Promise((resolve) => {
    const modal = document.getElementById('prompt-modal');
    document.getElementById('prompt-message').textContent = message;
    const input = document.getElementById('prompt-input');
    input.value = defaultValue || '';
    modal.classList.remove('hidden');
    const ok = document.getElementById('prompt-ok');
    const cancel = document.getElementById('prompt-cancel');
    function cleanup(result) {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(input.value); }
    function onCancel() { cleanup(null); }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    input.focus();
  });
}

// ─── Sound Effects (Web Audio API) ──────────────────────────────────────────

const sfx = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, type, startTime, duration, vol, c) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(vol, startTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    o.connect(g).connect(c.destination);
    o.start(startTime);
    o.stop(startTime + duration);
  }

  const sounds = {
    voiceJoin() {
      const c = getCtx(), t = c.currentTime;
      tone(440, 'sine', t, 0.15, 0.15, c);
      tone(587, 'sine', t + 0.1, 0.2, 0.15, c);
      tone(880, 'sine', t + 0.2, 0.25, 0.1, c);
    },
    voiceLeave() {
      const c = getCtx(), t = c.currentTime;
      tone(587, 'sine', t, 0.15, 0.12, c);
      tone(392, 'sine', t + 0.12, 0.25, 0.12, c);
    },
    msgSend() {
      const c = getCtx(), t = c.currentTime;
      tone(1200, 'sine', t, 0.06, 0.08, c);
      tone(1800, 'sine', t + 0.02, 0.04, 0.04, c);
    },
    msgReceive() {
      const c = getCtx(), t = c.currentTime;
      tone(800, 'sine', t, 0.08, 0.12, c);
      tone(1000, 'sine', t + 0.06, 0.12, 0.1, c);
    },
    callIncoming() {
      const c = getCtx(), t = c.currentTime;
      for (let i = 0; i < 3; i++) {
        tone(523, 'sine', t + i * 0.4, 0.15, 0.15, c);
        tone(659, 'sine', t + i * 0.4 + 0.15, 0.15, 0.15, c);
      }
    },
    callConnect() {
      const c = getCtx(), t = c.currentTime;
      tone(523, 'sine', t, 0.1, 0.12, c);
      tone(659, 'sine', t + 0.1, 0.1, 0.12, c);
      tone(784, 'sine', t + 0.2, 0.15, 0.1, c);
    },
    callEnd() {
      const c = getCtx(), t = c.currentTime;
      tone(440, 'sine', t, 0.15, 0.1, c);
      tone(330, 'sine', t + 0.12, 0.2, 0.1, c);
    },
    click() {
      const c = getCtx(), t = c.currentTime;
      tone(1000, 'sine', t, 0.03, 0.06, c);
    },
  };

  return {
    play(name) {
      try { if (sounds[name]) sounds[name](); } catch {}
    }
  };
})();

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
  // Custom avatar URLs (peerId -> url)
  peerAvatars: {},
  // Direct calls only (no TURN relay)
  directCallsOnly: false,
  // Relay audio state
  relayAudioActive: false,
  relayAudioWorklet: null,
  relayPlaybackWorklet: null,
  relayAudioContext: null,
  callTransport: null, // 'webrtc' | 'relay'
  // Dead Drops
  deadDrops: [],
  deadDropContents: {},
  deadDropVoted: {},
  // Polls
  polls: [],
  pollReceipts: {},
  pollResultsData: {},
  currentPollId: null,
  // Hubs
  hubs: [],
  activeHub: null,
  hubCategories: [],
  hubChannels: [],
  hubMembers: [],
  activeChannel: null,
  hubListings: [],
  memberPanelOpen: false,
  _selectingHub: false,  // guard against concurrent selectHub calls
  // Voice channels
  voiceChannel: null,      // { hubId, channelId, name } | null
  voicePeers: {},          // { [peerId]: { pc, remoteStream, name } }
  voiceOccupancy: {},      // { ['hubId:channelId']: { [peerId]: { name, joinedAt } } }
  voiceMuted: false,
  voiceLocalStream: null,
};

// ─── Hub Ranking Constants ──────────────────────────────────────────────────

const ACHIEVEMENT_META = {
  rising_star:    { label: 'Rising Star',    icon: '\u{1F31F}', desc: '10+ new members this week' },
  tight_knit:     { label: 'Tight Knit',     icon: '\u{1F91D}', desc: '>80% weekly active retention' },
  chatterbox:     { label: 'Chatterbox',     icon: '\u{1F4AC}', desc: '1000+ messages this week' },
  voice_hub:      { label: 'Voice Hub',      icon: '\u{1F399}', desc: '100+ voice hours total' },
  trusted_circle: { label: 'Trusted Circle', icon: '\u{1F6E1}', desc: '>50% members have trust vouches' },
  veteran:        { label: 'Veteran',        icon: '\u{1F3C6}', desc: 'Hub older than 30 days' },
  crowded_house:  { label: 'Crowded House',  icon: '\u{1F3E0}', desc: '50+ members' },
};

const TIER_COLORS = {
  Bronze:   '#8d6e3f',
  Silver:   '#6b7b8d',
  Gold:     '#c9a030',
  Platinum: '#5a8fa8',
  Diamond:  '#7c4dff',
};

// ─── Theme Presets ──────────────────────────────────────────────────────────

const THEME_PRESETS = [
  { id: 'default', name: 'Cassette', vars: { bgPrimary:'#212121', bgSecondary:'#262626', bgTertiary:'#2a2a2a', bgHover:'#303030', bgActive:'#32E0C412', border:'rgba(13,115,119,0.2)', textPrimary:'#EEEEEE', textSecondary:'#aaaaaa', textMuted:'#666666', accent:'#32E0C4', accentHover:'#5aebd4', green:'#32E0C4', red:'#e04050', orange:'#d4a020', msgSent:'#1a3a3a', msgReceived:'#2a2a2a', radius:'4px', radiusLg:'6px' }},
  { id: 'cyberpunk', name: 'Cyberpunk Neon', vars: { bgPrimary:'#0a0014', bgSecondary:'#120020', bgTertiary:'#1a0030', bgHover:'#2a0050', bgActive:'#ff00ff22', border:'#3a0060', textPrimary:'#f0e0ff', textSecondary:'#b080d0', textMuted:'#6a3090', accent:'#ff00ff', accentHover:'#ff44ff', green:'#00ff88', red:'#ff2040', orange:'#ffaa00', msgSent:'#3a0060', msgReceived:'#1a0030', radius:'2px', radiusLg:'4px' }},
  { id: 'vaporwave', name: 'Vaporwave', vars: { bgPrimary:'#1a0033', bgSecondary:'#220044', bgTertiary:'#2a0055', bgHover:'#3a0077', bgActive:'#ff71ce22', border:'#4a0088', textPrimary:'#ffe6ff', textSecondary:'#cc99dd', textMuted:'#7744aa', accent:'#ff71ce', accentHover:'#ff99dd', green:'#01cdfe', red:'#ff6e67', orange:'#ffd700', msgSent:'#4a0088', msgReceived:'#2a0055', radius:'4px', radiusLg:'6px' }},
  { id: 'forest', name: 'Forest', vars: { bgPrimary:'#0b1a0b', bgSecondary:'#112211', bgTertiary:'#1a331a', bgHover:'#224422', bgActive:'#22cc5522', border:'#2a442a', textPrimary:'#d0f0d0', textSecondary:'#88bb88', textMuted:'#446644', accent:'#22cc55', accentHover:'#44dd77', green:'#44ee66', red:'#ee4444', orange:'#ccaa22', msgSent:'#1a4422', msgReceived:'#1a331a', radius:'4px', radiusLg:'6px' }},
  { id: 'ocean', name: 'Ocean Depths', vars: { bgPrimary:'#0a1628', bgSecondary:'#0d1e33', bgTertiary:'#132840', bgHover:'#1a3555', bgActive:'#0099ff22', border:'#1a3555', textPrimary:'#d0e8ff', textSecondary:'#7799bb', textMuted:'#3a5577', accent:'#0099ff', accentHover:'#33aaff', green:'#00cc88', red:'#ff4466', orange:'#ffaa33', msgSent:'#0d3366', msgReceived:'#132840', radius:'4px', radiusLg:'6px' }},
  { id: 'light', name: 'Minimal Light', vars: { bgPrimary:'#ffffff', bgSecondary:'#f6f8fa', bgTertiary:'#eef1f5', bgHover:'#e2e6ea', bgActive:'#0969da22', border:'#d0d7de', textPrimary:'#1f2328', textSecondary:'#656d76', textMuted:'#8b949e', accent:'#0969da', accentHover:'#0c7eeb', green:'#1a7f37', red:'#cf222e', orange:'#bf8700', msgSent:'#ddf4ff', msgReceived:'#f6f8fa', radius:'4px', radiusLg:'6px' }},
  { id: 'sunset', name: 'Sunset', vars: { bgPrimary:'#1a0a0a', bgSecondary:'#221111', bgTertiary:'#2d1818', bgHover:'#442222', bgActive:'#ff660022', border:'#3d2222', textPrimary:'#ffe8d8', textSecondary:'#cc9988', textMuted:'#885544', accent:'#ff6600', accentHover:'#ff8833', green:'#44cc44', red:'#ff3333', orange:'#ffcc00', msgSent:'#442200', msgReceived:'#2d1818', radius:'4px', radiusLg:'6px' }},
  { id: 'terminal', name: 'Hacker', vars: { bgPrimary:'#000000', bgSecondary:'#0a0a0a', bgTertiary:'#111111', bgHover:'#1a1a1a', bgActive:'#00ff0022', border:'#222222', textPrimary:'#00ff00', textSecondary:'#00bb00', textMuted:'#006600', accent:'#00ff00', accentHover:'#33ff33', green:'#00ff00', red:'#ff0000', orange:'#ffff00', msgSent:'#002200', msgReceived:'#111111', radius:'0px', radiusLg:'0px' }},
  { id: 'warm-ember', name: 'Warm Ember', vars: { bgPrimary:'#1a1210', bgSecondary:'#211916', bgTertiary:'#2d221e', bgHover:'#3d302a', bgActive:'#f5a62322', border:'#3d302a', textPrimary:'#f0e0d0', textSecondary:'#b89880', textMuted:'#6b5545', accent:'#f5a623', accentHover:'#f7b84a', green:'#5cb85c', red:'#e74c3c', orange:'#e67e22', msgSent:'#3d2a1a', msgReceived:'#2d221e', radius:'4px', radiusLg:'6px' }},
  { id: 'rose-garden', name: 'Rose Garden', vars: { bgPrimary:'#1a0f14', bgSecondary:'#22141b', bgTertiary:'#2d1b25', bgHover:'#3d2835', bgActive:'#e8487f22', border:'#3d2835', textPrimary:'#f5e0ea', textSecondary:'#bb8899', textMuted:'#6b4455', accent:'#e8487f', accentHover:'#ef6d9a', green:'#55cc77', red:'#ff4466', orange:'#e6a040', msgSent:'#3d1830', msgReceived:'#2d1b25', radius:'4px', radiusLg:'6px' }},
  { id: 'sunrise', name: 'Sunrise', vars: { bgPrimary:'#13111f', bgSecondary:'#1a1728', bgTertiary:'#231f34', bgHover:'#332d48', bgActive:'#8b5cf622', border:'#332d48', textPrimary:'#ede6ff', textSecondary:'#a090c0', textMuted:'#5a4880', accent:'#8b5cf6', accentHover:'#a78bfa', green:'#4ade80', red:'#f87171', orange:'#fbbf24', msgSent:'#2d1f60', msgReceived:'#231f34', radius:'4px', radiusLg:'6px' }},
  { id: 'honey', name: 'Honey', vars: { bgPrimary:'#1a1712', bgSecondary:'#211e17', bgTertiary:'#2d2920', bgHover:'#3d3830', bgActive:'#d4a23a22', border:'#3d3830', textPrimary:'#f0e8d8', textSecondary:'#b8a888', textMuted:'#6b6050', accent:'#d4a23a', accentHover:'#e0b85a', green:'#6bc96b', red:'#e05555', orange:'#cc8833', msgSent:'#3d3020', msgReceived:'#2d2920', radius:'4px', radiusLg:'6px' }},
  { id: 'lavender', name: 'Lavender Dream', vars: { bgPrimary:'#16141f', bgSecondary:'#1d1a28', bgTertiary:'#262234', bgHover:'#352f48', bgActive:'#a78bfa22', border:'#352f48', textPrimary:'#ede8ff', textSecondary:'#a89cc0', textMuted:'#5e5478', accent:'#a78bfa', accentHover:'#c4b5fc', green:'#6ee7b7', red:'#fb7185', orange:'#fcd34d', msgSent:'#2e2260', msgReceived:'#262234', radius:'10px', radiusLg:'14px' }},
  { id: 'autumn', name: 'Autumn', vars: { bgPrimary:'#1a0e0c', bgSecondary:'#221412', bgTertiary:'#2d1c18', bgHover:'#3d2a24', bgActive:'#e0733422', border:'#3d2a24', textPrimary:'#f5e0d5', textSecondary:'#bb8877', textMuted:'#6b4a40', accent:'#e07334', accentHover:'#e89058', green:'#66bb6a', red:'#ef5350', orange:'#ff9800', msgSent:'#3d2010', msgReceived:'#2d1c18', radius:'4px', radiusLg:'6px' }},
  { id: 'neon-tokyo', name: 'Neon Tokyo', vars: { bgPrimary:'#0a0a14', bgSecondary:'#10101c', bgTertiary:'#181828', bgHover:'#252540', bgActive:'#ff2d5522', border:'#252540', textPrimary:'#eee8ff', textSecondary:'#9088b0', textMuted:'#504870', accent:'#ff2d55', accentHover:'#ff5577', green:'#00ffaa', red:'#ff3b5c', orange:'#ff9500', msgSent:'#3a1028', msgReceived:'#181828', radius:'6px', radiusLg:'10px' }},
  { id: 'ghost', name: 'Ghost', vars: { bgPrimary:'#0c0c10', bgSecondary:'#121218', bgTertiary:'#1a1a22', bgHover:'#24242e', bgActive:'#94a3b822', border:'#24242e', textPrimary:'#d4d4d8', textSecondary:'#71717a', textMuted:'#3f3f46', accent:'#94a3b8', accentHover:'#b0bec5', green:'#86efac', red:'#fca5a5', orange:'#fbbf24', msgSent:'#1e293b', msgReceived:'#1a1a22', radius:'4px', radiusLg:'6px' }},
  { id: 'synthwave84', name: 'Synthwave 84', vars: { bgPrimary:'#13111c', bgSecondary:'#1a1726', bgTertiary:'#241f34', bgHover:'#322a4a', bgActive:'#f9731622', border:'#322a4a', textPrimary:'#ffe4d0', textSecondary:'#c09880', textMuted:'#604838', accent:'#f97316', accentHover:'#fb923c', green:'#4ade80', red:'#f87171', orange:'#fbbf24', msgSent:'#3d1e06', msgReceived:'#241f34', radius:'4px', radiusLg:'8px' }},
  { id: 'void', name: 'Void', vars: { bgPrimary:'#000000', bgSecondary:'#060608', bgTertiary:'#0e0e14', bgHover:'#1a1a2e', bgActive:'#00d4ff22', border:'#1a1a2e', textPrimary:'#e0f0ff', textSecondary:'#6090b0', textMuted:'#304060', accent:'#00d4ff', accentHover:'#33ddff', green:'#00ffaa', red:'#ff4060', orange:'#ffaa00', msgSent:'#002a3a', msgReceived:'#0e0e14', radius:'0px', radiusLg:'2px' }},
  { id: 'emerald', name: 'Emerald', vars: { bgPrimary:'#0a1a14', bgSecondary:'#0f221a', bgTertiary:'#162d24', bgHover:'#1f3d30', bgActive:'#10b98122', border:'#1f3d30', textPrimary:'#d0f0e0', textSecondary:'#6aaa88', textMuted:'#3a6a50', accent:'#10b981', accentHover:'#34d399', green:'#22d97f', red:'#f87171', orange:'#fbbf24', msgSent:'#0a3d28', msgReceived:'#162d24', radius:'4px', radiusLg:'6px' }},
  { id: 'rust', name: 'Rust', vars: { bgPrimary:'#1a100a', bgSecondary:'#221610', bgTertiary:'#2d1e16', bgHover:'#3d2c20', bgActive:'#e2725b22', border:'#3d2c20', textPrimary:'#f0ddd0', textSecondary:'#b08068', textMuted:'#6a4838', accent:'#e2725b', accentHover:'#ea8f7a', green:'#6bc96b', red:'#ef5350', orange:'#ff9800', msgSent:'#3d1a10', msgReceived:'#2d1e16', radius:'6px', radiusLg:'10px' }},
  { id: 'sapphire', name: 'Sapphire', vars: { bgPrimary:'#0a0e1e', bgSecondary:'#0f1428', bgTertiary:'#161d36', bgHover:'#1e2a4a', bgActive:'#3b82f622', border:'#1e2a4a', textPrimary:'#d0e0ff', textSecondary:'#7090c0', textMuted:'#3a5080', accent:'#3b82f6', accentHover:'#60a5fa', green:'#4ade80', red:'#f87171', orange:'#fbbf24', msgSent:'#1e3a5f', msgReceived:'#161d36', radius:'4px', radiusLg:'6px' }},
  { id: 'plasma', name: 'Plasma', vars: { bgPrimary:'#0e0618', bgSecondary:'#140a20', bgTertiary:'#1c1030', bgHover:'#2a1a48', bgActive:'#c026d322', border:'#2a1a48', textPrimary:'#f0d8ff', textSecondary:'#a070c0', textMuted:'#603880', accent:'#c026d3', accentHover:'#d946ef', green:'#4ade80', red:'#f87171', orange:'#fbbf24', msgSent:'#3a1048', msgReceived:'#1c1030', radius:'6px', radiusLg:'10px' }},
  { id: 'chalk', name: 'Chalk', vars: { bgPrimary:'#fafaf9', bgSecondary:'#f5f5f4', bgTertiary:'#e7e5e4', bgHover:'#d6d3d1', bgActive:'#44403c22', border:'#d6d3d1', textPrimary:'#1c1917', textSecondary:'#57534e', textMuted:'#a8a29e', accent:'#44403c', accentHover:'#57534e', green:'#16a34a', red:'#dc2626', orange:'#d97706', msgSent:'#e7e5e4', msgReceived:'#f5f5f4', radius:'10px', radiusLg:'14px' }},
  { id: 'infrared', name: 'Infrared', vars: { bgPrimary:'#0a0404', bgSecondary:'#120808', bgTertiary:'#1c0e0e', bgHover:'#2e1616', bgActive:'#dc262622', border:'#2e1616', textPrimary:'#ffd0d0', textSecondary:'#b06060', textMuted:'#603030', accent:'#dc2626', accentHover:'#ef4444', green:'#4ade80', red:'#f87171', orange:'#fbbf24', msgSent:'#3a1010', msgReceived:'#1c0e0e', radius:'4px', radiusLg:'8px' }},
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

  // Animated background
  const bgLayer = document.getElementById('bg-animation-layer');
  if (bgLayer) {
    bgLayer.className = '';
    bgLayer.innerHTML = '';
    const animType = prefs.animationType || (prefs.background && prefs.background.animationType) || 'none';
    const animSpeed = prefs.animationSpeed || (prefs.background && prefs.background.animationSpeed) || 'normal';
    if (animType && animType !== 'none') {
      bgLayer.classList.add('bg-anim-' + animType);
      if (animSpeed === 'slow') bgLayer.classList.add('bg-anim-slow');
      else if (animSpeed === 'fast') bgLayer.classList.add('bg-anim-fast');
      // Create child elements for particles/fireflies
      if (animType === 'particles') {
        for (let i = 0; i < 18; i++) {
          const span = document.createElement('span');
          span.className = 'particle';
          span.style.left = (Math.random() * 100) + '%';
          span.style.animationDelay = (Math.random() * 8) + 's';
          span.style.animationDuration = (5 + Math.random() * 6) + 's';
          bgLayer.appendChild(span);
        }
      } else if (animType === 'fireflies') {
        for (let i = 0; i < 15; i++) {
          const span = document.createElement('span');
          span.className = 'firefly';
          span.style.left = (Math.random() * 100) + '%';
          span.style.top = (Math.random() * 100) + '%';
          span.style.animationDelay = (Math.random() * 6) + 's';
          span.style.animationDuration = (4 + Math.random() * 4) + 's';
          bgLayer.appendChild(span);
        }
      }
    }
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

  // Check for custom avatar (from peer's profile cardData)
  const customUrl = state.peerAvatars && state.peerAvatars[peerId];
  if (customUrl && isSafeMediaSrc(customUrl)) {
    // Replace canvas with an img element
    const s = size || canvas.width;
    const img = document.createElement('img');
    img.src = customUrl;
    img.style.width = s + 'px';
    img.style.height = s + 'px';
    img.style.borderRadius = '50%';
    img.style.objectFit = 'cover';
    img.className = canvas.className;
    if (canvas.onclick) img.onclick = canvas.onclick;
    if (canvas.dataset.peerid) img.dataset.peerid = canvas.dataset.peerid;
    if (canvas.parentNode) canvas.parentNode.replaceChild(img, canvas);
    return;
  }

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
  console.log('[OpenDescent] Connecting to', wsUrl);
  state.ws = new WebSocket(wsUrl);
  state.ws.binaryType = 'arraybuffer';

  state.ws.onopen = () => {
    const token = window.__DECENTRA_TOKEN || '';
    console.log('[OpenDescent] WS open, sending auth token:', token ? `${token.slice(0, 8)}...` : '(empty)');
    state.ws.send(JSON.stringify({ type: 'auth', token }));
  };

  let authDone = false;
  const origOnMessage = (event) => {
    if (!authDone) {
      const msg = JSON.parse(event.data);
      console.log('[OpenDescent] WS pre-auth message:', msg);
      if (msg.type === 'auth') {
        if (msg.ok) {
          authDone = true;
          state.ws.onmessage = handleWSMessage;
          onAuthenticated();
        } else {
          console.error('[OpenDescent] WebSocket auth failed');
          setConnectionStatus('offline');
        }
        return;
      }
    }
  };
  state.ws.onmessage = origOnMessage;

  function onAuthenticated() {
    console.log('[OpenDescent] Authenticated! Loading data...');
    setConnectionStatus('online');
    send('get_identity').then((data) => {
      state.myPeerId = data.peerId;
      state.myName = data.displayName;
      document.getElementById('my-name').textContent = data.displayName || 'Anonymous';
      document.getElementById('my-id').textContent = data.peerId;
      generateAvatar(data.peerId, document.getElementById('my-avatar'), 36);
      generateAvatar(data.peerId, document.getElementById('composer-avatar'), 36);
      // Load custom avatar if set
      send('get_profile', { peerId: data.peerId }).then(p => {
        if (p.profile?.cardData?.avatarUrl) {
          state.peerAvatars[data.peerId] = p.profile.cardData.avatarUrl;
          generateAvatar(data.peerId, document.getElementById('my-avatar'), 36);
          generateAvatar(data.peerId, document.getElementById('composer-avatar'), 36);
        }
      }).catch(() => {});
    }).catch(() => showToast('Load Error', 'Failed to load identity', 'error'));
    send('get_account_status').then((status) => {
      if (status.mode === 'legacy') showMnemonicModal();
    }).catch(() => showToast('Load Error', 'Failed to load account status', 'error'));
    // Load theme from backend
    send('get_theme').then((prefs) => {
      if (prefs) {
        state.themePrefs = prefs;
        applyTheme(prefs);
      }
    }).catch(() => {});
    refreshAll();
    loadFeed();

    // DMS auto check-in
    send('dms_check_in').catch(() => {});

    // Show theme spin wheel button after a short delay
    setTimeout(() => {
      document.getElementById('theme-wheel-hub').classList.remove('hidden');
    }, 1500);

    // Onboarding: show splash on first launch (after auth settles)
    setTimeout(() => {
      if (!localStorage.getItem('decentra_onboarded')) {
        // If mnemonic modal is showing (legacy user), defer until mnemonic completes
        const mnemonicModal = document.getElementById('mnemonic-modal');
        if (mnemonicModal && !mnemonicModal.classList.contains('hidden')) {
          onboardingPendingAfterMnemonic = true;
        } else {
          launchOnboarding();
        }
      }
    }, 500);
  }

  state.ws.onclose = (ev) => {
    console.warn('[OpenDescent] WS closed:', ev.code, ev.reason);
    setConnectionStatus('offline');
    state.connected = false;
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    if (state.callTimer) { clearInterval(state.callTimer); state.callTimer = null; }
    if (ev.code !== 1000) {
      showToast('Disconnected', 'Reconnecting...', 'error');
    }
    setTimeout(connectWS, 3000);
  };

  state.ws.onerror = (ev) => {
    console.error('[OpenDescent] WS error:', ev);
    showToast('Connection Error', 'Lost connection to backend', 'error');
  };
}

function handleWSMessage(event) {
  // Binary messages are relay audio chunks
  if (event.data instanceof ArrayBuffer) {
    handleRelayAudioChunk(event.data);
    return;
  }
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then(buf => handleRelayAudioChunk(buf));
    return;
  }

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
        showToast('Request Timeout', `"${action}" took too long`, 'error');
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
      // Refresh again after a brief delay to catch late mapping updates
      setTimeout(() => refreshContacts(), 1500);
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
    case 'vouch_updated':
    case 'vouch_revoked':
      // Refresh profile if we're viewing one — constellation updates in real-time
      if (state.activeView === 'profile') {
        const profilePeerId = document.querySelector('#profile-bento .card-identity')?.closest('[data-peerid]')?.dataset?.peerid;
        openProfile(profilePeerId || state.myPeerId);
      }
      break;
    case 'friend_request':
      showToast('Friend request received!', data.fromName);
      loadFriendRequests();
      break;
    case 'new_dead_drop':
      onNewDeadDrop(data);
      break;
    case 'new_poll':
      onNewPoll(data);
      break;
    case 'poll_results':
      onPollResultsEvent(data);
      break;
    case 'poll_vote_received':
      onPollVoteReceived(data);
      break;
    case 'hub_message':
      onHubMessage(data);
      break;
    case 'hub_updated':
      onHubUpdated(data);
      break;
    case 'hub_joined':
      showToast(`Joined hub "${data.name}"`);
      addHubNotification('Joined Hub', `You joined "${data.name}"`, data.hubId);
      refreshHubs();
      break;
    case 'hub_member_joined':
      showToast(`${data.displayName || 'Someone'} joined the hub`);
      addHubNotification('New Member', `${data.displayName || 'Someone'} joined`, data.hubId);
      if (state.activeHub && state.activeHub.hubId === data.hubId) refreshHubMembers(data.hubId);
      break;
    case 'hub_member_left':
      if (state.activeHub && state.activeHub.hubId === data.hubId) refreshHubMembers(data.hubId);
      break;
    case 'hub_invite_received':
      showToast(`Invited to hub "${data.hubName}"`, `by ${data.fromName}`);
      addHubNotification('Hub Invite', `${data.fromName} invited you to "${data.hubName}"`, data.hubId);
      refreshHubs();
      break;
    case 'message_deleted': {
      // Real-time deletion from remote peer
      const bubble = document.querySelector(`.message[data-msg-id="${data.messageId}"]`);
      if (bubble) {
        bubble.innerHTML = '<div class="msg-body" style="opacity:0.5;font-style:italic">Message deleted</div>';
      }
      break;
    }
  }
}

function onIncomingMessage(data) {
  const convoId = [state.myPeerId, data.from].sort().join(':');
  if (state.activeChat && state.activeChat.id === convoId) {
    // Show incoming bar briefly before the message appears
    showIncomingBar();
    setTimeout(() => {
      hideIncomingBar();
      appendMessage({ from: data.from, body: data.body, timestamp: data.timestamp, status: 'delivered' });
    }, 800);
  }
  sfx.play('msgReceive');
  showToast(`${data.fromName}: ${data.body.slice(0, 50)}`);
  refreshConversations();
}

function onIncomingGroupMessage(data) {
  const convoId = `group:${data.groupId}`;
  if (state.activeChat && state.activeChat.id === convoId) {
    appendMessage({ from: data.from, fromName: data.fromName, body: data.body, timestamp: data.timestamp, status: 'delivered' });
  }
  sfx.play('msgReceive');
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
  await Promise.all([refreshContacts(), refreshConversations(), refreshGroups(), refreshHubs(), loadLicenseStatus()]);
}

const refreshContacts = debounce(async () => {
  try { state.contacts = await send('get_contacts'); renderContacts(); } catch (e) { console.error('Failed to refresh contacts:', e); }
}, 500);

const refreshConversations = debounce(async () => {
  try { state.conversations = await send('get_conversations'); renderConversations(); } catch (e) { console.error('Failed to refresh conversations:', e); }
}, 500);

async function refreshGroups() {
  try { state.groups = await send('get_groups'); renderGroups(); } catch (e) { console.error('Failed to refresh groups:', e); }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderConversations() {
  const el = document.getElementById('conversations-list');
  if (state.conversations.length === 0) {
    el.innerHTML = '<div class="empty-state-rich"><div class="empty-state-icon">&#128172;</div><div class="empty-state-text"><strong>No conversations yet</strong>Start chatting with a peer!</div></div>';
    return;
  }
  el.innerHTML = state.conversations.map((c) => {
    const isActive = state.activeChat && state.activeChat.id === c.conversationId;
    const time = formatTime(c.lastMessage.timestamp);
    let preview = c.lastMessage.body || '';
    if (preview.startsWith('{')) {
      try {
        const parsed = JSON.parse(preview);
        if (parsed.type === 'voicenote') preview = '🎤 Voice note';
        else if (parsed.type === 'file' || parsed.contentId) preview = '📎 File';
        else if (parsed.type === 'image') preview = '🖼 Image';
        else if (parsed.type === 'video') preview = '🎬 Video';
        else preview = `[${parsed.type || 'attachment'}]`;
      } catch { /* not JSON, use as-is */ }
    }
    preview = preview.slice(0, 40);
    const icon = c.isGroup ? '&#128101; ' : '';
    return `
      <div class="list-item ${isActive ? 'active' : ''}"
           onclick="openConversation('${escapeAttr(c.conversationId)}', '${escapeAttr(c.displayName)}', ${c.isGroup})">
        <div class="item-name">${icon}${escapeHtml(c.displayName)} <span class="item-time">${time}</span></div>
        <div class="item-preview">${escapeHtml(preview)}</div>
      </div>`;
  }).join('');
}

function renderContacts() {
  const el = document.getElementById('contacts-list');
  if (state.contacts.length === 0) {
    el.innerHTML = '<div class="empty-state-rich"><div class="empty-state-icon">&#128101;</div><div class="empty-state-text"><strong>No contacts yet</strong>Connect with peers to start!</div></div>';
    return;
  }

  const friends = state.contacts.filter(c => c.isFriend);
  const others = state.contacts.filter(c => !c.isFriend);

  let html = '';

  if (friends.length > 0) {
    html += `<div class="contact-section-label">FRIENDS</div>`;
    html += friends.map(c => renderContactItem(c)).join('');
  }

  if (others.length > 0) {
    html += `<div class="contact-section-label">NETWORK</div>`;
    html += others.map(c => renderContactItem(c)).join('');
  }

  el.innerHTML = html;
}

function renderContactItem(c) {
  const name = escapeHtml(c.displayName || c.peerId.slice(0, 12));
  const safePeerId = escapeAttr(c.peerId);
  const safeName = escapeAttr(c.displayName || c.peerId.slice(0, 12));
  const unreadBadge = c.unreadCount > 0 ? `<span class="unread-badge">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : '';
  const friendIcon = c.isFriend ? '<span class="friend-icon" title="Friend">&#9733;</span>' : '';
  const statusDot = c.online ? '<span class="online-dot"></span>' : '<span class="offline-dot-sm"></span>';

  return `
    <div class="list-item contact-item ${c.unreadCount > 0 ? 'has-unread' : ''}" onclick="startDM('${safePeerId}', '${safeName}')">
      <div class="item-info">
        <div class="item-name">
          ${statusDot}${friendIcon}${name}${unreadBadge}
        </div>
        <div class="item-preview">${c.peerId.slice(0, 20)}...</div>
      </div>
      <div class="contact-actions">
        <button class="btn-icon btn-remove" onclick="event.stopPropagation(); removeFriend('${safePeerId}', '${safeName}')" title="Remove"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg></button>
        <button class="btn-icon btn-block" onclick="event.stopPropagation(); blockPeer('${safePeerId}', '${safeName}')" title="Block"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="5.5"/><line x1="3.1" y1="3.1" x2="10.9" y2="10.9"/></svg></button>
      </div>
    </div>`;
}

function renderGroups() {
  const el = document.getElementById('groups-list');
  if (state.groups.length === 0) {
    el.innerHTML = '<div class="empty-state-rich"><div class="empty-state-icon">&#128101;</div><div class="empty-state-text"><strong>No groups yet</strong>Create one to start collaborating!</div></div>';
    return;
  }
  el.innerHTML = state.groups.map((g) => `
    <div class="list-item" onclick="openGroup('${escapeAttr(g.groupId)}', '${escapeAttr(g.name)}')">
      <div class="item-name">&#128101; ${escapeHtml(g.name)}</div>
      <div class="item-preview">${g.memberCount} members</div>
      <button class="btn-icon btn-leave-group" onclick="event.stopPropagation(); leaveGroup('${escapeAttr(g.groupId)}', '${escapeAttr(g.name)}')" title="Leave group"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg></button>
    </div>`
  ).join('');
}

function renderMessages(messages) {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  let lastDate = '';
  for (const m of messages) {
    const date = new Date(m.timestamp).toLocaleDateString();
    if (date !== lastDate) { lastDate = date; el.innerHTML += `<div class="date-separator">${escapeHtml(date)}</div>`; }
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
      // Cache the blob data lazily — only decode on playback, not on render
      if (vnMsg.data && !vnBlobCache.has(vnMsg.contentId)) {
        vnBlobCache.set(vnMsg.contentId, vnMsg.data); // store raw data URL, decode on play
      }
      m.voicenote = vnMsg;
      el.innerHTML += renderVoicenoteMessageHTML(isMine, vnMsg, time, senderHTML);
      continue;
    }
    const msgDeleteBtn = `<button class="msg-delete-btn" onclick="deleteMessage('${escapeAttr(m.messageId)}', ${m.timestamp}, ${isMine})" title="Delete">&#128465;</button>`;
    el.innerHTML += `
        <div class="message ${isMine ? 'sent' : 'received'}" data-msg-id="${escapeAttr(m.messageId)}">
          ${senderHTML}
          <div class="msg-body">${renderContentWithGifs(m.body)}</div>
          <div class="msg-time">${time} ${isMine ? `<span class="msg-status">${m.status || ''}</span>` : ''}${msgDeleteBtn}</div>
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
    if (vnMsg.data && !vnBlobCache.has(vnMsg.contentId)) {
      vnBlobCache.set(vnMsg.contentId, vnMsg.data);
    }
    msg.voicenote = vnMsg;
    appendVoicenoteMessage(msg, true);
    return;
  }
  const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  el.insertAdjacentHTML('beforeend', `
      <div class="message ${isMine ? 'sent' : 'received'} message-new" id="${msgId}">
        ${senderHTML}
        <div class="msg-body">${escapeHtml(msg.body)}</div>
        <div class="msg-time">${time}
          <span class="msg-crypto-status crypto-encrypting"><span class="status-dot-sm"></span>${isMine ? 'ENCRYPTING' : 'DECRYPTING'}</span>
        </div>
      </div>`);
  scrollToBottom();

  // Trigger encryption visualization
  requestAnimationFrame(() => {
    const msgEl = document.getElementById(msgId);
    if (!msgEl) return;
    setTimeout(() => msgEl.classList.remove('message-new'), 250);
    if (isMine) {
      animateSendEncrypt(msgEl, msg.body);
    } else {
      animateReceiveDecrypt(msgEl, msg.body);
    }
  });
}

function renderFileMessageHTML(isMine, senderName, fileInfo, time) {
  return `
    <div class="message ${isMine ? 'sent' : 'received'} file-message">
      <div class="msg-body">
        &#128206; <strong>${escapeHtml(fileInfo.fileName)}</strong><br>
        <span class="subtle">${formatBytes(fileInfo.fileSize)}</span>
        ${!isMine ? `<br><button class="file-download-btn" onclick="downloadFile('${escapeAttr(fileInfo.contentId)}')">Download</button>` : ''}
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
  document.getElementById('deaddrops-view').classList.toggle('hidden', view !== 'deaddrops');
  document.getElementById('hub-overview').classList.toggle('hidden', view !== 'hub-overview');
  // Mobile: toggle sidebar/chat visibility
  document.getElementById('app').classList.toggle('chat-open', view === 'chat');
}

function mobileBackToSidebar() {
  document.getElementById('app').classList.remove('chat-open');
  state.activeChat = null;
  state.activeChannel = null;
  showView('empty');
}

// ─── Chat Navigation ────────────────────────────────────────────────────────

async function openConversation(conversationId, displayName, isGroup) {
  clearTypingIndicators();
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
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '<div class="loading-state"><div class="spinner"></div>Loading messages...</div>';
  try {
    const messages = await send('get_history', { conversationId, limit: 100 });
    state.messages = messages;
    renderMessages(messages);
    // Mark as read
    send('mark_read', { conversationId }).catch(() => {});
    refreshContacts(); // Update unread badges
  } catch (e) { console.error('Failed to load history:', e); }
}

function startDM(peerId, displayName) {
  const conversationId = [state.myPeerId, peerId].sort().join(':');
  openConversation(conversationId, displayName, false);
  switchTab('chats');
}

async function removeFriend(peerId, name) {
  if (!await showConfirm(`Remove ${name} from contacts?`)) return;
  try {
    await send('remove_friend', { peerId });
    showToast('Removed', `${name} removed from contacts`, 'info');
    refreshAll();
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
}

async function blockPeer(peerId, name) {
  if (!await showConfirm(`Block ${name}? They will be removed from your contacts and their messages will be silently dropped.`)) return;
  try {
    await send('block_peer', { peerId });
    showToast('Blocked', `${name} has been blocked`, 'info');
    refreshAll();
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
}

async function unblockPeer(peerId) {
  try {
    await send('unblock_peer', { peerId });
    showToast('Unblocked', 'Peer unblocked', 'info');
    loadBlockedPeers();
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
}

async function loadBlockedPeers() {
  try {
    const blocked = await send('get_blocked');
    const el = document.getElementById('blocked-peers-list');
    if (!el) return;
    if (!blocked || blocked.length === 0) {
      el.innerHTML = '<p class="subtle">No blocked peers.</p>';
      return;
    }
    el.innerHTML = blocked.map((peerId) => `
      <div class="blocked-peer-item">
        <span>${escapeHtml(peerId.slice(0, 20))}...</span>
        <button class="btn-secondary" onclick="unblockPeer('${escapeAttr(peerId)}')">Unblock</button>
      </div>`
    ).join('');
  } catch {}
}

async function deleteAccount() {
  if (!await showConfirm('Delete your account? This will permanently erase all data including your identity, messages, and contacts. This cannot be undone.')) return;
  const typed = await showPrompt('Type DELETE to confirm:');
  if (typed !== 'DELETE') {
    showToast('Cancelled', 'Account deletion cancelled', 'info');
    return;
  }
  try {
    await send('delete_account', { confirm: 'DELETE' });
    document.getElementById('app').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;color:var(--text-primary);background:var(--bg-primary)"><h2>Account Deleted</h2><p style="margin-top:12px;color:var(--text-secondary)">All data has been wiped. Please restart the application.</p></div>';
    if (state.ws) state.ws.close();
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
}

function openGroup(groupId, name) {
  const conversationId = `group:${groupId}`;
  openConversation(conversationId, name, true);
  switchTab('chats');
}

async function leaveGroup(groupId, name) {
  if (!await showConfirm(`Leave group "${name}"?`)) return;
  try {
    await send('leave_group', { groupId });
    showToast('Left Group', `You left "${name}"`, 'info');
    if (state.activeChat && state.activeChat.id === `group:${groupId}`) {
      state.activeChat = null;
      showView('empty');
    }
    refreshAll();
  } catch (e) {
    showToast('Error', e.message, 'error');
  }
}

// ─── Sending Messages ───────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  // Hub channel message
  if (state.activeChannel) {
    try {
      await send('send_hub_message', { hubId: state.activeChannel.hubId, channelId: state.activeChannel.channelId, text });
      appendMessage({ from: state.myPeerId, body: text, timestamp: Date.now(), status: 'sent' });
      sfx.play('msgSend');
    } catch (e) { showToast('Failed to send message', e.message); }
    return;
  }
  if (!state.activeChat) return;
  try {
    if (state.activeChat.type === 'dm') await send('send_message', { to: state.activeChat.peerId, text });
    else await send('send_group_message', { groupId: state.activeChat.groupId, text });
    appendMessage({ from: state.myPeerId, body: text, timestamp: Date.now(), status: 'sent' });
    sfx.play('msgSend');
    refreshConversations();
  } catch (e) { showToast('Failed to send message', e.message); }
}

// ─── Typing Indicator ────────────────────────────────────────────────────────

let typingTimeout = null;
let typingSent = false;
const typingPeers = {}; // peerId -> { name, timeout }

function sendTypingIndicator() {
  if (!state.activeChat || state.activeChat.type !== 'dm') return;
  if (typingSent) return; // Don't spam
  typingSent = true;
  send('call_signal', {
    peerId: state.activeChat.peerId,
    signal: { type: 'typing', from: state.myPeerId, fromName: state.myName },
  }).catch(() => {});
  // Allow next typing signal after 2s
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { typingSent = false; }, 2000);
}

function onTypingReceived(fromId, fromName) {
  // Don't show if not in this conversation
  const convoId = state.activeChat && state.activeChat.type === 'dm' ? state.activeChat.id : null;
  const expectedConvo = convoId ? [state.myPeerId, fromId].sort().join(':') : null;
  if (!convoId || convoId !== expectedConvo) return;

  // Set/reset the typing indicator
  if (typingPeers[fromId]) clearTimeout(typingPeers[fromId].timeout);
  typingPeers[fromId] = {
    name: fromName || fromId.slice(0, 12),
    timeout: setTimeout(() => {
      delete typingPeers[fromId];
      renderTypingIndicator();
    }, 3000),
  };
  renderTypingIndicator();
}

function renderTypingIndicator() {
  let el = document.getElementById('typing-indicator');
  const names = Object.values(typingPeers).map(p => p.name);

  if (names.length === 0) {
    if (el) el.classList.add('hidden');
    return;
  }

  if (!el) {
    el = document.createElement('div');
    el.id = 'typing-indicator';
    el.className = 'typing-indicator';
    const container = document.getElementById('messages-container');
    if (container) container.appendChild(el);
  }

  const who = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-text">${escapeHtml(who)} is typing</span>`;
  el.classList.remove('hidden');
  scrollToBottom();
}

// Clear typing indicators when sending a message or switching chats
function clearTypingIndicators() {
  for (const id of Object.keys(typingPeers)) {
    clearTimeout(typingPeers[id].timeout);
    delete typingPeers[id];
  }
  renderTypingIndicator();
}

// ─── Encryption Visualization Engine ─────────────────────────────────────────

const HEX_CHARS = '0123456789abcdef';
const ROUTE_NODES = ['EU-W7', 'REL-1', 'NAC-4', 'MX-2', 'AS-E2'];

function randomHexChar() {
  return HEX_CHARS[Math.floor(Math.random() * HEX_CHARS.length)];
}

function randomCipherChar() {
  // Mix of hex and separator characters for realistic ciphertext look
  const r = Math.random();
  if (r < 0.7) return randomHexChar();
  if (r < 0.85) return ':';
  return ' ';
}

// Generate a fake but realistic SHA-256 fingerprint
function generateFingerprint(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const abs = Math.abs(hash);
  let fp = '';
  for (let i = 0; i < 16; i++) {
    fp += HEX_CHARS[(abs * (i + 7) * 31) % 16];
    if (i % 4 === 3 && i < 15) fp += ':';
  }
  return fp;
}

// Subtle sound effects
const cryptoSfx = {
  _ctx: null,
  _getCtx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._ctx;
  },
  tick() {
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800 + Math.random() * 400;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.02, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.05);
    } catch {}
  },
  lock() {
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(900, ctx.currentTime + 0.08);
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  },
  hop() {
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 1200 + Math.random() * 200;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.015, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
    } catch {}
  },
};

function scrambleText(text, fraction) {
  return text.split('').map((ch, i) => {
    if (ch === ' ') return ' ';
    const prob = (fraction * fraction); // quadratic acceleration
    return Math.random() < prob ? randomCipherChar() : ch;
  }).join('');
}

function resolveText(original, scrambled, fraction) {
  return original.split('').map((ch, i) => {
    if (ch === ' ') return ' ';
    const prob = (fraction * fraction);
    return Math.random() < prob ? ch : scrambled[i] || randomCipherChar();
  }).join('');
}

// Generate fully scrambled version of text
function fullScramble(text) {
  return text.split('').map(ch => ch === ' ' ? ' ' : randomCipherChar()).join('');
}

// Create cipher machine HTML — full security pipeline
function createCipherMachineHTML(mode) {
  return `<div class="cipher-machine">
    <div class="cipher-pipeline">
      <div class="pipeline-step" data-step="keyex">
        <span class="pipeline-icon">&#9656;</span>
        <span class="pipeline-label">X25519 KEY</span>
        <span class="pipeline-status">WAITING</span>
      </div>
      <div class="pipeline-step" data-step="cipher">
        <span class="pipeline-icon"><span class="cipher-lock"></span></span>
        <span class="pipeline-label">AES-256-GCM</span>
        <span class="pipeline-status">WAITING</span>
      </div>
      <div class="pipeline-step" data-step="sign">
        <span class="pipeline-icon">&#9998;</span>
        <span class="pipeline-label">Ed25519 ${mode === 'encrypt' ? 'SIGN' : 'VERIFY'}</span>
        <span class="pipeline-status">WAITING</span>
      </div>
    </div>
    <div class="cipher-tape-row">
      <div class="cipher-tape cipher-tape-in"></div>
      <span class="cipher-arrow">&#9654;</span>
      <div class="cipher-tape cipher-tape-out"></div>
    </div>
  </div>`;
}

// Create route strip HTML
function createRouteStripHTML() {
  // Use real peer names if available, fall back to generated node IDs
  const peerNodes = [];
  const connected = (state.contacts || []).filter(c => c.online).slice(0, 3);
  peerNodes.push(ROUTE_NODES[0]); // origin
  if (connected.length > 0) {
    peerNodes.push('REL-1');
    connected.forEach(c => peerNodes.push((c.displayName || c.peerId.slice(0, 6)).toUpperCase().slice(0, 6)));
  } else {
    peerNodes.push(...ROUTE_NODES.slice(1));
  }

  const nodes = peerNodes.map((n, i) =>
    `<span class="route-node" data-idx="${i}">${n}</span>`
  ).join('<span class="route-dash">—</span>');
  return `<div class="route-strip">
    <div class="route-strip-inner">
      <span class="route-label">ROUTE</span>${nodes}
    </div>
  </div>`;
}

// Activate a pipeline step with status
async function activateStep(msgEl, stepName, status, active) {
  const step = msgEl.querySelector(`.pipeline-step[data-step="${stepName}"]`);
  if (!step) return;
  const statusEl = step.querySelector('.pipeline-status');
  if (statusEl) statusEl.textContent = status;
  if (active) {
    step.classList.add('active');
  } else {
    step.classList.remove('active');
    step.classList.add('done');
  }
}

// Animation tracking
let pendingAnimations = 0;

function quickCryptoStatus(msgEl, plaintext, isSend) {
  const bodyEl = msgEl.querySelector('.msg-body');
  const statusEl = msgEl.querySelector('.msg-crypto-status');
  if (!bodyEl) return;
  // Quick flash — show status without full pipeline animation
  bodyEl.innerHTML = renderContentWithGifs(plaintext);
  const fp = generateFingerprint(plaintext);
  if (statusEl) {
    statusEl.innerHTML = `<span class="status-dot-sm"></span>${isSend ? 'DELIVERED' : 'DECRYPTED'}`;
    statusEl.className = `msg-crypto-status ${isSend ? 'crypto-delivered' : 'crypto-decrypted'}`;
  }
  const fpBadge = document.createElement('div');
  fpBadge.className = 'msg-fingerprint';
  fpBadge.innerHTML = `<span class="fp-lock">&#9656;</span> SHA ${fp}`;
  bodyEl.after(fpBadge);
}

// Run the send encryption animation on a message element
async function animateSendEncrypt(msgEl, plaintext) {
  pendingAnimations++;
  const bodyEl = msgEl.querySelector('.msg-body');
  const statusEl = msgEl.querySelector('.msg-crypto-status');
  if (!bodyEl) return;

  const fp = generateFingerprint(plaintext);

  // Insert cipher machine + route strip
  const machineHTML = createCipherMachineHTML('encrypt');
  const routeHTML = createRouteStripHTML();
  bodyEl.insertAdjacentHTML('beforebegin', machineHTML + routeHTML);

  const machine = msgEl.querySelector('.cipher-machine');
  const routeStrip = msgEl.querySelector('.route-strip');
  const tapeIn = msgEl.querySelector('.cipher-tape-in');
  const tapeOut = msgEl.querySelector('.cipher-tape-out');
  const arrows = msgEl.querySelectorAll('.cipher-arrow');

  // Show machine
  await new Promise(r => setTimeout(r, 50));
  machine.classList.add('active');
  scrollToBottom();

  // Step 1: Key Exchange
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>KEY EXCHANGE'; statusEl.className = 'msg-crypto-status crypto-encrypting'; }
  await activateStep(msgEl, 'keyex', 'AGREEING', true);
  await new Promise(r => setTimeout(r, 400));
  cryptoSfx.lock();
  await activateStep(msgEl, 'keyex', 'AGREED ✓', false);
  await new Promise(r => setTimeout(r, 150));

  // Step 2: Encrypt
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>ENCRYPTING'; }
  await activateStep(msgEl, 'cipher', 'PROCESSING', true);
  arrows.forEach(a => a.classList.add('lit'));

  const steps = Math.min(Math.ceil(plaintext.length / 2), 25);
  const interval = Math.max(30, Math.min(45, 1000 / steps));

  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const processedLen = Math.floor(frac * plaintext.length);
    tapeIn.textContent = plaintext.slice(Math.max(0, processedLen - 18), processedLen);
    const scrambled = scrambleText(plaintext, frac);
    // Output tape shows hex-style ciphertext
    let hexOut = '';
    for (let j = 0; j < Math.min(processedLen, 18); j++) hexOut += randomHexChar();
    tapeOut.textContent = hexOut;
    bodyEl.textContent = scrambled;
    if (i % 3 === 0) cryptoSfx.tick();
    await new Promise(r => setTimeout(r, interval));
  }

  const fullCipher = fullScramble(plaintext);
  bodyEl.textContent = fullCipher;
  cryptoSfx.lock();
  await activateStep(msgEl, 'cipher', 'DONE ✓', false);

  // Lock pulse on message border
  msgEl.classList.add('crypto-locked');
  await new Promise(r => setTimeout(r, 200));

  // Step 3: Sign
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>SIGNING'; }
  await activateStep(msgEl, 'sign', 'SIGNING', true);
  await new Promise(r => setTimeout(r, 350));
  cryptoSfx.lock();
  await activateStep(msgEl, 'sign', 'SIGNED ✓', false);
  await new Promise(r => setTimeout(r, 200));

  // Fade out machine
  machine.classList.remove('active');
  await new Promise(r => setTimeout(r, 300));

  // Step 4: Route
  routeStrip.classList.add('active');
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>ROUTING'; statusEl.className = 'msg-crypto-status crypto-routing'; }

  const nodes = routeStrip.querySelectorAll('.route-node');
  const dashes = routeStrip.querySelectorAll('.route-dash');
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].classList.add('lit');
    if (dashes[i]) dashes[i].classList.add('lit');
    cryptoSfx.hop();
    await new Promise(r => setTimeout(r, 160));
  }

  await new Promise(r => setTimeout(r, 250));
  routeStrip.classList.remove('active');

  // Step 5: Final resolve — crystallization
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>DELIVERED'; statusEl.className = 'msg-crypto-status crypto-delivered'; }
  msgEl.classList.remove('crypto-locked');

  const resolveSteps = 9;
  let currentText = fullCipher;
  for (let i = 1; i <= resolveSteps; i++) {
    const frac = i / resolveSteps;
    currentText = resolveText(plaintext, currentText, frac);
    bodyEl.textContent = currentText;
    await new Promise(r => setTimeout(r, 40));
  }

  bodyEl.innerHTML = renderContentWithGifs(plaintext);

  // Show fingerprint badge
  const fpBadge = document.createElement('div');
  fpBadge.className = 'msg-fingerprint';
  fpBadge.innerHTML = `<span class="fp-lock">&#9656;</span> SHA ${fp}`;
  bodyEl.after(fpBadge);

  // Clean up
  await new Promise(r => setTimeout(r, 500));
  machine.remove();
  routeStrip.remove();
  pendingAnimations--;
}

// Run the receive decrypt animation on a message element
async function animateReceiveDecrypt(msgEl, plaintext) {
  pendingAnimations++;
  const bodyEl = msgEl.querySelector('.msg-body');
  const statusEl = msgEl.querySelector('.msg-crypto-status');
  if (!bodyEl) return;

  const fp = generateFingerprint(plaintext);

  // Start with hex-style scrambled text
  const scrambled = fullScramble(plaintext);
  bodyEl.textContent = scrambled;

  // Insert cipher machine
  const machineHTML = createCipherMachineHTML('decrypt');
  bodyEl.insertAdjacentHTML('beforebegin', machineHTML);
  const machine = msgEl.querySelector('.cipher-machine');
  const tapeIn = msgEl.querySelector('.cipher-tape-in');
  const tapeOut = msgEl.querySelector('.cipher-tape-out');
  const arrows = msgEl.querySelectorAll('.cipher-arrow');

  await new Promise(r => setTimeout(r, 50));
  machine.classList.add('active');
  scrollToBottom();

  // Step 1: Verify signature
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>VERIFYING'; statusEl.className = 'msg-crypto-status crypto-decrypting'; }
  await activateStep(msgEl, 'sign', 'VERIFYING', true);
  await new Promise(r => setTimeout(r, 350));
  cryptoSfx.lock();
  await activateStep(msgEl, 'sign', 'VALID ✓', false);
  await new Promise(r => setTimeout(r, 150));

  // Step 2: Key exchange
  await activateStep(msgEl, 'keyex', 'DERIVING', true);
  await new Promise(r => setTimeout(r, 300));
  cryptoSfx.lock();
  await activateStep(msgEl, 'keyex', 'READY ✓', false);
  await new Promise(r => setTimeout(r, 150));

  // Step 3: Decrypt — linear left-to-right sweep
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>DECRYPTING'; }
  await activateStep(msgEl, 'cipher', 'DECRYPTING', true);
  arrows.forEach(a => a.classList.add('lit'));

  const steps = Math.min(Math.ceil(plaintext.length / 2), 25);
  const interval = Math.max(30, Math.min(45, 1000 / steps));

  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const resolvedLen = Math.floor(frac * plaintext.length);

    // Hex-style input tape
    let hexIn = '';
    for (let j = 0; j < Math.min(resolvedLen, 18); j++) hexIn += randomHexChar();
    tapeIn.textContent = hexIn;
    tapeOut.textContent = plaintext.slice(Math.max(0, resolvedLen - 18), resolvedLen);

    // Body: left resolved, right jittering hex
    let bodyText = plaintext.slice(0, resolvedLen);
    for (let j = resolvedLen; j < plaintext.length; j++) {
      bodyText += plaintext[j] === ' ' ? ' ' : (Math.random() < 0.3 ? randomHexChar() : scrambled[j] || randomHexChar());
    }
    bodyEl.textContent = bodyText;
    if (i % 3 === 0) cryptoSfx.tick();
    await new Promise(r => setTimeout(r, interval));
  }

  cryptoSfx.lock();
  await activateStep(msgEl, 'cipher', 'DONE ✓', false);
  bodyEl.innerHTML = renderContentWithGifs(plaintext);

  // Lock pulse
  msgEl.classList.add('crypto-locked');
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>DECRYPTED'; statusEl.className = 'msg-crypto-status crypto-decrypted'; }

  // Show fingerprint
  const fpBadge = document.createElement('div');
  fpBadge.className = 'msg-fingerprint';
  fpBadge.innerHTML = `<span class="fp-lock">&#9656;</span> SHA ${fp}`;
  bodyEl.after(fpBadge);

  await new Promise(r => setTimeout(r, 300));
  msgEl.classList.remove('crypto-locked');
  machine.classList.remove('active');
  await new Promise(r => setTimeout(r, 400));
  machine.remove();
  pendingAnimations--;
}

// Show incoming transmission bar
function showIncomingBar() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  let bar = container.querySelector('.incoming-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'incoming-bar';
    bar.innerHTML = '&#9656; Receiving encrypted transmission<span class="incoming-dots"></span>';
    container.appendChild(bar);
    scrollToBottom();
  }
}

function hideIncomingBar() {
  const bars = document.querySelectorAll('.incoming-bar');
  bars.forEach(b => b.remove());
}

// ─── Privacy Shield (Scramble All Messages) ─────────────────────────────────

let privacyShieldActive = false;
const privacyOriginals = new Map(); // msgEl -> original innerHTML

async function togglePrivacyShield() {
  const btn = document.getElementById('btn-privacy-shield');
  const messages = document.querySelectorAll('#messages .message');

  if (privacyShieldActive) {
    // Decrypt all — quick cascade reveal
    btn.innerHTML = '&#128274;'; // locked
    btn.title = 'Privacy Shield — scramble all messages';
    btn.classList.remove('shield-active');

    // Cascade reveal with stagger
    const msgArray = Array.from(messages);
    for (let i = 0; i < msgArray.length; i++) {
      const msg = msgArray[i];

      // Handle voicenote messages
      const vnPlayer = msg.querySelector('.voicenote-player');
      if (vnPlayer) {
        setTimeout(() => {
          msg.classList.remove('privacy-scrambled');
          const overlay = msg.querySelector('.vn-scramble-overlay');
          if (overlay) overlay.remove();
          const playBtn = msg.querySelector('.vn-play-btn');
          if (playBtn) playBtn.disabled = false;
        }, i * 30);
        continue;
      }

      const body = msg.querySelector('.msg-body');
      if (!body || !privacyOriginals.has(msg)) continue;

      const original = privacyOriginals.get(msg);

      // Quick resolve — 4 steps
      const plaintext = original;
      const scrambled = body.textContent;
      setTimeout(() => {
        let step = 0;
        const revealInterval = setInterval(() => {
          step++;
          if (step >= 4) {
            clearInterval(revealInterval);
            body.innerHTML = renderContentWithGifs(plaintext);
            msg.classList.remove('privacy-scrambled');
            return;
          }
          const frac = step / 4;
          body.textContent = resolveText(plaintext, scrambled, frac);
        }, 35);
      }, i * 30); // stagger
    }

    privacyOriginals.clear();
    privacyShieldActive = false;

    // Update status strip
    const strip = document.querySelector('.chat-status-strip .micro-text');
    if (strip) strip.innerHTML = '&#9656;&#9656; E2E ENCRYPTED // AES-256-GCM // DIRECT P2P';

  } else {
    // Encrypt all — cascade scramble
    btn.innerHTML = '&#128275;'; // unlocked (to indicate click will unlock)
    btn.title = 'Reveal messages';
    btn.classList.add('shield-active');

    const msgArray = Array.from(messages);
    for (let i = 0; i < msgArray.length; i++) {
      const msg = msgArray[i];

      // Handle voicenote messages
      const vnPlayer = msg.querySelector('.voicenote-player');
      if (vnPlayer) {
        setTimeout(() => {
          msg.classList.add('privacy-scrambled');
          const playBtn = msg.querySelector('.vn-play-btn');
          if (playBtn) playBtn.disabled = true;
          // Add scramble overlay
          if (!msg.querySelector('.vn-scramble-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'vn-scramble-overlay';
            overlay.innerHTML = '<span class="vn-scramble-lock">&#128274;</span> AUDIO ENCRYPTED // AES-256-GCM';
            vnPlayer.style.position = 'relative';
            vnPlayer.appendChild(overlay);
          }
        }, i * 20);
        continue;
      }

      const body = msg.querySelector('.msg-body');
      if (!body) continue;

      // Store original text content
      const original = body.textContent;
      privacyOriginals.set(msg, original);

      // Cascade scramble with stagger
      setTimeout(() => {
        let step = 0;
        const scrambleInterval = setInterval(() => {
          step++;
          if (step >= 5) {
            clearInterval(scrambleInterval);
            body.textContent = fullScramble(original);
            msg.classList.add('privacy-scrambled');
            return;
          }
          const frac = step / 5;
          body.textContent = scrambleText(original, frac);
        }, 30);
      }, i * 20); // fast stagger — wave effect
    }

    privacyShieldActive = true;
    cryptoSfx.lock();

    // Update status strip
    const strip = document.querySelector('.chat-status-strip .micro-text');
    if (strip) strip.innerHTML = '&#9656;&#9656; PRIVACY SHIELD ACTIVE // MESSAGES SCRAMBLED';
  }
}

// ─── File Sharing ───────────────────────────────────────────────────────────

// ─── Chunked File Upload ──────────────────────────────────────────────────

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

async function uploadFileChunked(file, purpose, recipientId) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const arrayBuffer = await file.arrayBuffer();

  // Init
  const init = await send('upload_init', {
    fileName: file.name,
    totalSize: file.size,
    totalChunks,
    mimeType: file.type,
    purpose,
    recipientId,
  });
  const uploadId = init.uploadId;

  // Show persistent progress bar
  showUploadProgress(file.name, 0);

  // Send chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = new Uint8Array(arrayBuffer.slice(start, end));
    const chunkData = btoa(chunk.reduce((data, byte) => data + String.fromCharCode(byte), ''));

    await send('upload_chunk', { uploadId, chunkIndex: i, chunkData });

    const pct = Math.round(((i + 1) / totalChunks) * 100);
    showUploadProgress(file.name, pct);
  }

  // Show processing state while backend encrypts + shards
  showUploadProgress(file.name + ' — processing...', 100);

  // Finish
  const result = await send('upload_finish', { uploadId });
  hideUploadProgress();
  return result;
}

function showUploadProgress(fileName, pct) {
  let bar = document.getElementById('upload-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'upload-progress-bar';
    bar.innerHTML = `<div class="upload-progress-inner"><span class="upload-progress-name"></span><div class="upload-progress-track"><div class="upload-progress-fill"></div></div><span class="upload-progress-pct"></span></div>`;
    document.body.appendChild(bar);
  }
  bar.querySelector('.upload-progress-name').textContent = fileName;
  bar.querySelector('.upload-progress-pct').textContent = pct + '%';
  bar.querySelector('.upload-progress-fill').style.width = pct + '%';
  bar.classList.remove('hidden');
}

function hideUploadProgress() {
  const bar = document.getElementById('upload-progress-bar');
  if (bar) bar.classList.add('hidden');
}

function triggerFileShare() {
  if (!state.activeChat || state.activeChat.type !== 'dm') return;
  document.getElementById('file-input').click();
}

async function handleFileSelected(event) {
  const file = event.target.files[0];
  if (!file || !state.activeChat) return;
  try {
    showToast('Sharing file...', file.name);
    await uploadFileChunked(file, 'share', state.activeChat.peerId);
    showToast('File shared!', file.name);
    refreshConversations();
  } catch (e) { showToast('Failed to share file', e.message); }
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
    const text = p.vars.textPrimary;
    return `<button class="theme-preset-btn ${p.id === currentId ? 'active' : ''}" data-preset="${p.id}" onclick="selectPreset('${p.id}')">
      <div class="theme-preview-swatch" style="background:linear-gradient(135deg,${bg} 40%,${accent})"></div>
      ${escapeHtml(p.name)}
    </button>`;
  }).join('');

  // Set current values
  const prefs = state.themePrefs || {};
  const preset = THEME_PRESETS.find(p => p.id === (prefs.presetId || 'default')) || THEME_PRESETS[0];
  const vars = { ...preset.vars, ...(prefs.customOverrides || {}) };
  document.getElementById('setting-font-size').value = prefs.fontSize || 14;
  document.getElementById('font-size-val').textContent = (prefs.fontSize || 14) + 'px';
  document.getElementById('setting-radius').value = parseInt(vars.radius) || 8;
  document.getElementById('radius-val').textContent = (parseInt(vars.radius) || 8) + 'px';
  document.getElementById('setting-bg-mode').value = prefs.background?.mode || 'solid';
  document.getElementById('setting-bg-pattern').value = prefs.background?.patternType || 'dots';
  document.getElementById('setting-bg-pattern').classList.toggle('hidden', (prefs.background?.mode || 'solid') !== 'pattern');

  // Animation
  document.getElementById('setting-anim-type').value = prefs.animationType || 'none';
  document.getElementById('setting-anim-speed').value = prefs.animationSpeed || 'normal';

  // Font family
  document.getElementById('setting-font-family').value = prefs.fontFamily || '';

  // Bubble style
  document.querySelectorAll('.bubble-option').forEach(el => {
    el.classList.toggle('active', el.dataset.style === (prefs.bubbleStyle || 'modern'));
  });

  // Advanced colors — populate all 16 color pickers
  populateColorEditor(vars);

  // License status
  loadLicenseStatus();

  // GIF API key
  loadGifApiKey();

  // Blocked peers
  loadBlockedPeers();

  // Audio settings
  document.getElementById('setting-noise-gate').checked = noiseGateEnabled;
  document.getElementById('setting-direct-calls').checked = state.directCallsOnly;

  // Version
  document.getElementById('settings-version').textContent = 'OpenDescent v0.5.3';

  modal.classList.remove('hidden');
}

function populateColorEditor(vars) {
  const fields = ['bgPrimary','bgSecondary','bgTertiary','bgHover','bgActive','textPrimary','textSecondary','textMuted','accent','accentHover','msgSent','msgReceived','green','red','orange','border'];
  for (const f of fields) {
    const el = document.getElementById('ce-' + f);
    if (el) {
      let val = vars[f] || '#000000';
      // Handle colors with alpha (e.g. #1f6feb22) — strip to 7 chars
      if (val.length > 7) val = val.slice(0, 7);
      el.value = val;
    }
  }
  // Wire live preview
  for (const f of fields) {
    const el = document.getElementById('ce-' + f);
    if (el && !el._ceWired) {
      el._ceWired = true;
      el.addEventListener('input', () => livePreviewColors());
    }
  }
}

function livePreviewColors() {
  const overrides = getColorEditorOverrides();
  const prefs = { ...state.themePrefs, customOverrides: { ...(state.themePrefs?.customOverrides || {}), ...overrides } };
  applyTheme(prefs);
}

function getColorEditorOverrides() {
  const fields = ['bgPrimary','bgSecondary','bgTertiary','bgHover','bgActive','textPrimary','textSecondary','textMuted','accent','accentHover','msgSent','msgReceived','green','red','orange','border'];
  const preset = THEME_PRESETS.find(p => p.id === (state.themePrefs?.presetId || 'default')) || THEME_PRESETS[0];
  const overrides = {};
  for (const f of fields) {
    const el = document.getElementById('ce-' + f);
    if (!el) continue;
    const val = el.value;
    let presetVal = preset.vars[f] || '';
    if (presetVal.length > 7) presetVal = presetVal.slice(0, 7);
    if (val !== presetVal) overrides[f] = val;
  }
  return overrides;
}

function toggleAdvancedColors() {
  const panel = document.getElementById('advanced-colors-panel');
  const btn = document.getElementById('advanced-colors-toggle');
  panel.classList.toggle('hidden');
  btn.classList.toggle('open');
}

function exportTheme() {
  const prefs = state.themePrefs || {};
  const json = JSON.stringify(prefs, null, 2);
  navigator.clipboard.writeText(json).then(() => showToast('Theme Exported', 'Copied to clipboard', 'success'));
}

function importTheme() {
  const json = prompt('Paste theme JSON:');
  if (!json) return;
  try {
    const prefs = JSON.parse(json);
    if (!prefs.presetId) throw new Error('Invalid theme');
    state.themePrefs = prefs;
    applyTheme(prefs);
    showSettingsModal(); // refresh the modal
    showToast('Theme Imported', 'Applied successfully', 'success');
  } catch (e) {
    showToast('Import Failed', 'Invalid theme JSON', 'error');
  }
}

function selectPreset(id) {
  document.querySelectorAll('.theme-preset-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.preset === id);
  });
  // Preview immediately and update color editor
  const preset = THEME_PRESETS.find(p => p.id === id);
  if (preset) {
    const prefs = { ...state.themePrefs, presetId: id, customOverrides: undefined };
    applyTheme(prefs);
    populateColorEditor(preset.vars);
  }
}

async function saveSettings() {
  const presetId = document.querySelector('.theme-preset-btn.active')?.dataset.preset || 'default';
  const fontSize = parseInt(document.getElementById('setting-font-size').value);
  const radius = parseInt(document.getElementById('setting-radius').value);
  const bubbleStyle = document.querySelector('.bubble-option.active')?.dataset.style || 'modern';
  const bgMode = document.getElementById('setting-bg-mode').value;
  const patternType = document.getElementById('setting-bg-pattern').value;
  const animType = document.getElementById('setting-anim-type').value;
  const animSpeed = document.getElementById('setting-anim-speed').value;
  const fontFamily = document.getElementById('setting-font-family').value;

  const preset = THEME_PRESETS.find(p => p.id === presetId) || THEME_PRESETS[0];
  // Gather overrides from advanced color editor
  const colorOverrides = getColorEditorOverrides();
  const customOverrides = { ...colorOverrides };
  if (radius + 'px' !== preset.vars.radius) {
    customOverrides.radius = radius + 'px';
    customOverrides.radiusLg = Math.min(radius + 4, 20) + 'px';
  }

  const prefs = {
    presetId,
    customOverrides: Object.keys(customOverrides).length > 0 ? customOverrides : undefined,
    fontSize,
    bubbleStyle,
    fontFamily: fontFamily || undefined,
    animationType: animType !== 'none' ? animType : undefined,
    animationSpeed: animSpeed !== 'normal' ? animSpeed : undefined,
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

  try { await send('set_theme', prefs); } catch (e) { showToast('Failed to save theme', e.message, 'error'); }
  document.getElementById('settings-modal').classList.add('hidden');
}

// ─── Data Export ─────────────────────────────────────────────────────────────

async function exportMyData() {
  const btn = document.getElementById('btn-export-data');
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting...'; }
  try {
    const data = await send('export_data', {});
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().split('T')[0];
    a.href = url;
    a.download = `opendescent-export-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Export Complete', 'Your data has been downloaded', 'success');
  } catch (e) {
    showToast('Export Failed', e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download My Data'; }
  }
}

// ─── Profile View (Phase 2) ─────────────────────────────────────────────────

async function openProfile(peerId) {
  const targetId = peerId || state.myPeerId;
  showView('profile');

  try {
    const data = await send('get_profile', { peerId: targetId });
    // Cache custom avatar URL
    if (data.profile?.cardData?.avatarUrl) {
      state.peerAvatars[targetId] = data.profile.cardData.avatarUrl;
    } else {
      delete state.peerAvatars[targetId];
    }
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
      case 'identity': {
        const avatarHtml = cardData.avatarUrl && isSafeMediaSrc(cardData.avatarUrl)
          ? `<img src="${cardData.avatarUrl}" class="profile-avatar-large" style="width:80px;height:80px;border-radius:50%;object-fit:cover">`
          : `<canvas class="profile-avatar-large" width="80" height="80" data-peerid="${peerId}"></canvas>`;
        const isFounder = (data.isSelf && state.licenseStatus && state.licenseStatus.founder) || cardData.isFounder;
        const founderBadge = isFounder ? '<span class="founder-badge" title="Founder — one of the first 101">&#9733; FOUNDER</span>' : '';
        html += `<div class="bento-card card-identity ${sizeClass}">
          ${avatarHtml}
          <div class="identity-info">
            <h2>${escapeHtml(displayName)}</h2>
            ${founderBadge}
            ${cardData.tagline ? `<div class="tagline">${escapeHtml(cardData.tagline)}</div>` : ''}
            <div class="subtle" style="font-family:monospace;font-size:0.75em;margin-top:4px">${peerId.slice(0, 20)}...</div>
          </div>
        </div>`;
        break;
      }
      case 'vibe':
        if (cardData.vibe) {
          const v = cardData.vibe;
          const safeGradStart = isSafeColor(v.gradientStart) ? v.gradientStart : '#ff6b6b';
          const safeGradEnd = isSafeColor(v.gradientEnd) ? v.gradientEnd : '#4ecdc4';
          html += `<div class="bento-card card-vibe ${sizeClass}" style="background:linear-gradient(135deg,${safeGradStart},${safeGradEnd})">
            <div class="vibe-emoji">${escapeHtml(v.emoji)}</div>
            <div class="vibe-text">${escapeHtml(v.text)}</div>
          </div>`;
        }
        break;
      case 'about':
        if (cardData.about) {
          const fontClass = isSafeFontStyle(cardData.about.fontStyle) && cardData.about.fontStyle !== 'sans' ? 'font-' + cardData.about.fontStyle : '';
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
        // Replaced by Vital Signs card below
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
        // Replaced by Trust Constellation card below
        break;
    }
  }

  // ─── Vital Signs Card ──────────────────────────────
  const pulseClass = data.isOnline ? 'pulse-online' : 'pulse-offline';
  const statusText = data.isOnline ? 'SIGNAL LOCKED' : 'OFFLINE';
  const statusColor = data.isOnline ? 'var(--accent)' : 'var(--text-ghost)';
  html += `<div class="bento-card card-vitals size-large">
    <div class="vitals-header">
      <div class="micro-label">&#9656;&#9656; VITAL SIGNS // &#29983;&#21629;&#24500;&#20505;</div>
    </div>
    <div class="vitals-grid">
      <div class="vital-item">
        <div class="vital-ring ${pulseClass}">
          <div class="vital-ring-inner" style="border-color:${statusColor}"></div>
        </div>
        <div class="vital-label">STATUS</div>
        <div class="vital-value" style="color:${statusColor}">${statusText}</div>
      </div>
      <div class="vital-item">
        <div class="vital-big">${data.meshDepth || 0}</div>
        <div class="vital-label">MESH DEPTH</div>
        <div class="vital-sub">reachable peers</div>
      </div>
      <div class="vital-item">
        <div class="vital-big">${data.friendCount || 0}</div>
        <div class="vital-label">CONNECTIONS</div>
        <div class="vital-sub">trusted links</div>
      </div>
      <div class="vital-item">
        <div class="vital-big">${data.vouchCount || 0}</div>
        <div class="vital-label">VOUCHES</div>
        <div class="vital-sub">reputation score</div>
      </div>
    </div>
  </div>`;

  // ─── Trust Constellation ──────────────────────────
  const vouchGraph = data.vouchGraph || [];
  html += `<div class="bento-card card-constellation size-large">
    <div class="constellation-header">
      <div class="micro-label">&#9656;&#9656; TRUST WEB // &#20449;&#38972;&#32178;</div>
      <span class="micro-text">${vouchGraph.length} vouch${vouchGraph.length !== 1 ? 'es' : ''}</span>
    </div>
    <canvas id="constellation-canvas" width="600" height="250"></canvas>
    ${vouchGraph.length === 0 ? '<div class="constellation-empty">No vouches yet. Ask trusted peers to vouch for you.</div>' : ''}
  </div>`;

  // Trust section (after bento cards)
  const isSelf = data.isSelf;
  const safePeerId = escapeAttr(peerId);
  if (!isSelf) {
    html += `<div class="trust-section" id="trust-section-${safePeerId}">`;
    // Vouch / Revoke button
    if (data.isFriend && !data.isVouched) {
      html += `<button class="vouch-btn" onclick="vouchForPeer('${safePeerId}')">&#128737; Vouch for ${escapeHtml(displayName)}</button>`;
    } else if (data.isVouched) {
      html += `<button class="revoke-vouch-btn" id="revoke-btn-${safePeerId}">&#128737; Vouched &mdash; Click to Revoke</button>`;
    }
    // Trust path placeholder
    html += `<div id="trust-path-${safePeerId}" class="trust-path-container"></div>`;
    html += `</div>`;
  }

  bento.innerHTML = html;

  // Wire revoke button if present
  if (!isSelf && data.isVouched) {
    send('get_my_vouches').then(vouches => {
      const myVouch = vouches.find(v => v.toId === peerId);
      if (myVouch) {
        const btn = document.getElementById('revoke-btn-' + peerId);
        if (btn) btn.onclick = () => revokeVouch(myVouch.vouchId, peerId);
      }
    }).catch(() => {});
  }

  // Load trust path for non-self, non-direct-friend peers
  if (!isSelf) {
    loadTrustPath(peerId).then(result => {
      const el = document.getElementById('trust-path-' + peerId);
      if (el && result && result.found && result.distance > 1) {
        el.innerHTML = `<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:6px">Trust path (${result.distance} hops):</div>` + renderTrustPath(result);
        requestAnimationFrame(() => {
          el.querySelectorAll('canvas[data-peerid]').forEach(c => generateAvatar(c.dataset.peerid, c, 28));
        });
      }
    }).catch(() => {});
  }

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

    // Draw trust constellation
    drawConstellation(peerId, displayName, data.vouchGraph || [], data.isOnline);
  });
}

function drawConstellation(centerId, centerName, vouchGraph, isOnline) {
  const canvas = document.getElementById('constellation-canvas');
  if (!canvas || vouchGraph.length === 0) return;

  // Size canvas to actual container width
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const displayW = Math.floor(rect.width - 40); // padding
  const displayH = Math.min(280, Math.max(200, displayW * 0.4));
  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = displayW;
  const h = displayH;
  const cx = w / 2;
  const cy = h / 2;

  ctx.clearRect(0, 0, w, h);

  // Position voucher nodes in a circle around center
  const nodes = vouchGraph.map((v, i) => {
    const angle = (i / vouchGraph.length) * Math.PI * 2 - Math.PI / 2;
    const radius = 80 + Math.random() * 30;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      name: v.fromName,
      isOnline: v.isOnline,
      isMutual: v.isMutual,
      peerId: v.fromId,
    };
  });

  // Animate
  let frame = 0;
  function draw() {
    frame++;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Draw connections from center to each voucher
    for (const node of nodes) {
      const lineAlpha = node.isMutual ? 0.25 : 0.1;
      const lineWidth = node.isMutual ? 1.5 : 0.8;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(node.x, node.y);
      ctx.strokeStyle = `rgba(50, 224, 196, ${lineAlpha})`;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      // Data pulse along connection
      if (node.isOnline && frame % 120 < 30) {
        const t = (frame % 120) / 30;
        const px = cx + (node.x - cx) * t;
        const py = cy + (node.y - cy) * t;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(50, 224, 196, ${0.5 * (1 - t)})`;
        ctx.fill();
      }
    }

    // Draw voucher nodes
    for (const node of nodes) {
      const glow = node.isOnline ? 0.6 + Math.sin(frame * 0.03) * 0.2 : 0.2;
      const r = node.isMutual ? 5 : 4;

      // Outer glow
      if (node.isOnline) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(50, 224, 196, ${glow * 0.15})`;
        ctx.fill();
      }

      // Node dot
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = node.isOnline ? `rgba(50, 224, 196, ${glow})` : 'rgba(100, 100, 100, 0.4)';
      ctx.fill();

      // Name label
      ctx.font = '8px monospace';
      ctx.fillStyle = node.isOnline ? 'rgba(170, 170, 170, 0.8)' : 'rgba(100, 100, 100, 0.5)';
      ctx.textAlign = 'center';
      ctx.fillText(node.name, node.x, node.y + r + 12);

      // Mutual badge
      if (node.isMutual) {
        ctx.fillStyle = 'rgba(50, 224, 196, 0.6)';
        ctx.fillText('\u2194', node.x, node.y - r - 4);
      }
    }

    // Draw center node (the profile owner)
    const centerGlow = isOnline ? 0.8 + Math.sin(frame * 0.04) * 0.2 : 0.3;

    // Center outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(50, 224, 196, ${centerGlow * 0.3})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center pulse ring
    if (isOnline) {
      const pulseR = 14 + (frame % 60) * 0.5;
      const pulseA = 0.3 * (1 - (frame % 60) / 60);
      ctx.beginPath();
      ctx.arc(cx, cy, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(50, 224, 196, ${pulseA})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(50, 224, 196, ${centerGlow})`;
    ctx.fill();

    // Center name
    ctx.font = '600 10px Array, sans-serif';
    ctx.fillStyle = 'rgba(238, 238, 238, 0.9)';
    ctx.textAlign = 'center';
    ctx.fillText(centerName.toUpperCase(), cx, cy + 24);

    requestAnimationFrame(draw);
  }
  draw();
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

  // Avatar — Pro only
  const isPro = state.licenseStatus && state.licenseStatus.valid && state.licenseStatus.tier === 'pro';
  document.getElementById('btn-avatar-gif').disabled = !isPro;
  document.getElementById('btn-avatar-upload').disabled = !isPro;
  document.getElementById('btn-avatar-clear').disabled = !isPro;
  document.getElementById('avatar-free-hint').classList.toggle('hidden', isPro);
  state.pendingAvatarUrl = cd.avatarUrl || null;
  updateAvatarPreview(cd.avatarUrl);

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

function updateAvatarPreview(url) {
  const box = document.getElementById('avatar-preview');
  if (url && isSafeMediaSrc(url)) {
    box.innerHTML = `<img src="${url}" alt="avatar">`;
  } else {
    box.innerHTML = `<canvas id="edit-avatar-canvas" width="64" height="64"></canvas>`;
    generateAvatar(state.myPeerId, box.querySelector('canvas'), 64);
  }
}

function pickAvatarGif() {
  showGifPicker('avatar', document.getElementById('btn-avatar-gif'));
}

function clearAvatar() {
  state.pendingAvatarUrl = null;
  updateAvatarPreview(null);
}

// Wire avatar upload input
document.addEventListener('DOMContentLoaded', () => {
  const avatarInput = document.getElementById('avatar-upload-input');
  if (avatarInput) {
    avatarInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { showToast('Image too large (max 2MB)'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        state.pendingAvatarUrl = reader.result;
        updateAvatarPreview(reader.result);
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
  }
});

async function saveProfile() {
  const cards = getDefaultCards().map(c => {
    const checkbox = document.querySelector(`#card-toggles input[data-card="${c.type}"]`);
    return { ...c, enabled: checkbox ? checkbox.checked : c.enabled };
  });

  const cardData = {
    avatarUrl: state.pendingAvatarUrl || undefined,
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
  const isBrowse = !term;
  const el = document.getElementById('discover-results');
  // Show loading state
  el.innerHTML = '<div class="loading-state"><div class="spinner"></div>Searching network...</div>';
  try {
    const results = await send('search_peers', { searchTerm: term, maxResults: 50, dhtDiscovery: true });
    const friendIds = new Set((await send('get_friends')).map(f => f.peerId));
    renderDiscoverResults(results, friendIds, isBrowse);
  } catch (e) { showToast('Search failed', e.message); }
}

function renderDiscoverResults(results, friendIds, isBrowse) {
  const el = document.getElementById('discover-results');
  // Update the section title based on mode
  const titleEl = el.previousElementSibling;
  if (titleEl && titleEl.classList.contains('section-title')) {
    titleEl.textContent = isBrowse ? 'People on the Network' : 'Search Results';
  }
  if (results.length === 0) {
    el.innerHTML = isBrowse
      ? '<div class="list-item"><span class="subtle">No peers discovered yet — connect to more nodes to find people</span></div>'
      : '<div class="list-item"><span class="subtle">No peers found matching your search</span></div>';
    return;
  }
  // Sort: local > gossip > dht, then online first, then friends, then alphabetically
  const sourceOrder = { local: 0, gossip: 1, dht: 2 };
  results.sort((a, b) => {
    const aSrc = sourceOrder[a.source] ?? 1;
    const bSrc = sourceOrder[b.source] ?? 1;
    if (aSrc !== bSrc) return aSrc - bSrc;
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    const aFriend = friendIds.has(a.peerId);
    const bFriend = friendIds.has(b.peerId);
    if (aFriend !== bFriend) return aFriend ? -1 : 1;
    return (a.displayName || '').localeCompare(b.displayName || '');
  });
  el.innerHTML = results.map(r => {
    const isFriend = friendIds.has(r.peerId);
    const safePeerId = escapeAttr(r.peerId);
    const distanceLabel = r.source === 'dht'
      ? '<span class="dht-badge">Network</span>'
      : `${r.hopDistance} hop${r.hopDistance > 1 ? 's' : ''}`;
    return `<div class="discover-card">
      <canvas width="40" height="40" data-peerid="${safePeerId}"></canvas>
      <div class="discover-info">
        <div class="discover-name" onclick="openPeerProfile('${safePeerId}')" style="cursor:pointer">${escapeHtml(r.displayName)}</div>
        <div class="discover-meta">${r.isOnline ? '<span class="online-dot"></span> Online' : 'Offline'} &middot; ${distanceLabel}${r.vouchCount ? ' &middot; <span class="vouch-count-badge">&#128737; ' + r.vouchCount + '</span>' : ''}</div>
      </div>
      ${isFriend
        ? '<span class="discover-action friend-badge">Friend</span>'
        : `<button class="discover-action" onclick="sendFriendRequest('${safePeerId}')">Add Friend</button>`}
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
    if (requests.length === 0) {
      section.classList.remove('hidden');
      list.innerHTML = '<div class="empty-state-rich"><div class="empty-state-icon">&#9996;</div><div class="empty-state-text"><strong>No pending requests</strong>You\'re all caught up!</div></div>';
      return;
    }
    section.classList.remove('hidden');
    list.innerHTML = requests.map(r => {
      const safeReqId = escapeAttr(r.requestId);
      const safeFrom = escapeAttr(r.from);
      return `<div class="friend-req-item">
        <canvas width="32" height="32" data-peerid="${safeFrom}"></canvas>
        <div class="friend-req-info">
          <div class="friend-req-name">${escapeHtml(r.fromName)}</div>
          ${r.message ? `<div class="friend-req-msg">${escapeHtml(r.message)}</div>` : ''}
        </div>
        <div class="friend-req-actions">
          <button class="btn-accept" onclick="respondFriendRequest('${safeReqId}', true)">Accept</button>
          <button class="btn-reject" onclick="respondFriendRequest('${safeReqId}', false)">Reject</button>
        </div>
      </div>`;
    }).join('');
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

// ─── Trust Web ──────────────────────────────────────────────────────────────

async function vouchForPeer(peerId) {
  try {
    await send('vouch_peer', { peerId });
    showToast('Vouched!', 'Trust vouch recorded');
    openProfile(peerId);
  } catch (e) { showToast('Failed to vouch', e.message); }
}

async function revokeVouch(vouchId, peerId) {
  try {
    await send('revoke_vouch', { vouchId });
    showToast('Vouch revoked');
    openProfile(peerId);
  } catch (e) { showToast('Failed to revoke', e.message); }
}

async function loadTrustPath(peerId) {
  try {
    const result = await send('get_trust_path', { toId: peerId });
    return result;
  } catch (e) {
    console.error('Failed to load trust path:', e);
    return null;
  }
}

function renderTrustPath(pathResult) {
  if (!pathResult || !pathResult.found || pathResult.path.length <= 1) return '';
  const nodes = pathResult.path.map((n, i) => {
    const name = escapeHtml(n.displayName || n.peerId.slice(0, 8));
    const safePeerId = escapeAttr(n.peerId);
    const isFirst = i === 0;
    const isLast = i === pathResult.path.length - 1;
    const label = isFirst ? 'You' : name;
    return `<div class="trust-path-node" onclick="openPeerProfile('${safePeerId}')" title="${name}">
      <canvas width="28" height="28" data-peerid="${safePeerId}"></canvas>
      <span>${label}</span>
    </div>`;
  });
  return `<div class="trust-path-chain">${nodes.join('<span class="trust-arrow">&rarr;</span>')}</div>`;
}

// ─── Feed & Posts (Phase 4) ─────────────────────────────────────────────────

const loadFeed = debounce(async () => {
  const feedEl = document.getElementById('feed-posts');
  if (!feedEl.children.length || feedEl.querySelector('.empty-state-rich')) {
    feedEl.innerHTML = '<div class="loading-state"><div class="spinner"></div>Loading feed...</div>';
  }
  try {
    const [posts, polls, friends] = await Promise.all([
      send('get_timeline', { limit: 50 }),
      send('get_polls', { scope: 'public', limit: 50 }).catch(() => []),
      send('get_friends').catch(() => []),
    ]);
    state.feedPosts = posts;
    state.polls = polls;
    feedFriendIds = new Set(friends.map(f => f.peerId));
    // Cache vote/results state
    for (const p of polls) {
      if (p.hasVoted) state.pollReceipts[p.pollId] = p.votedOptionIndex;
      if (p.results) state.pollResultsData[p.pollId] = p.results;
    }
    renderFeed();
  } catch (e) { console.error('Failed to load feed:', e); }
}, 300);

let _feedRafId = 0;
function renderFeed() {
  const el = document.getElementById('feed-posts');
  // Merge posts + polls into single sorted array
  const items = [];
  for (const post of state.feedPosts) {
    items.push({ type: 'post', data: post, timestamp: post.timestamp });
  }
  for (const poll of state.polls) {
    items.push({ type: 'poll', data: poll, timestamp: poll.createdAt });
  }

  // Apply feed algorithm (filter + sort + diversity)
  const processed = applyFeedAlgorithm(items);

  if (processed.length === 0) {
    const emptyMsg = feedFilter === 'friends'
      ? '<strong>No friend posts yet</strong>Add friends to see their posts here!'
      : feedFilter === 'trending'
      ? '<strong>No trending posts</strong>Posts with likes and comments will appear here!'
      : '<strong>No posts yet</strong>Be the first to share something!';
    el.innerHTML = `<div class="empty-state-rich"><div class="empty-state-icon">&#128172;</div><div class="empty-state-text">${emptyMsg}</div></div>`;
    return;
  }
  el.innerHTML = processed.map(item => item.type === 'post' ? renderPostCard(item.data) : renderPollCard(item.data)).join('');
  // Render avatars + voicenote waveforms (cancel any pending rAF to avoid stacking)
  cancelAnimationFrame(_feedRafId);
  _feedRafId = requestAnimationFrame(() => {
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
      const safeContentId = escapeAttr(att.contentId);
      if (att.type === 'image' && imgSrc && isSafeMediaSrc(imgSrc)) {
        mediaHTML += `<div class="post-media-item"><img src="${imgSrc}" alt=""></div>`;
      } else if (att.type === 'image' && imgSrc) {
        mediaHTML += `<div class="post-media-item"><span class="subtle">Unsafe image source blocked</span></div>`;
      } else if (att.type === 'voicenote') {
        const hasData = !!att.data;
        const hasWaveform = att.waveform && att.waveform.length > 0;
        const safeWaveform = hasWaveform ? escapeAttr(JSON.stringify(att.waveform)) : '';
        mediaHTML += `<div class="voicenote-player">
          <button class="vn-play-btn" onclick="playVoicenote('${safeContentId}')" ${!hasData ? 'disabled title="No audio data"' : ''}>&#9654;</button>
          ${hasWaveform
            ? `<canvas class="vn-waveform-display" data-contentid="${safeContentId}" data-waveform="${safeWaveform}" width="200" height="30"></canvas>`
            : `<div class="vn-bar"></div>`}
          <span class="vn-duration">${att.duration ? formatDuration(att.duration) : '--:--'}</span>
        </div>`;
      } else if (att.type === 'audio' && att.data) {
        mediaHTML += `<div class="voicenote-player">
          <button class="vn-play-btn" onclick="playVoicenote('${safeContentId}')">&#9654;</button>
          <div class="vn-bar"></div>
          <span class="vn-duration">${escapeHtml(att.fileName || 'audio')}</span>
        </div>`;
      } else if (att.type === 'video' && att.data && isSafeMediaSrc(att.data)) {
        mediaHTML += `<div class="post-media-item"><video src="${att.data}" controls style="max-width:100%;max-height:300px"></video></div>`;
      } else if (att.fileInfo || att.contentId) {
        // Sharded media — show load button (with thumbnail if available)
        const safeFileInfo = escapeAttr(JSON.stringify(att.fileInfo || {}));
        const safeMime = escapeAttr(att.mimeType || 'application/octet-stream');
        const mediaType = att.type || 'file';
        const hasThumbnail = att.thumbnail && isSafeMediaSrc(att.thumbnail);
        const icon = mediaType === 'video' ? '&#9654;' : mediaType === 'image' ? '&#128247;' : mediaType === 'audio' ? '&#9835;' : '&#128190;';
        if (hasThumbnail) {
          mediaHTML += `<div class="post-media-item post-media-loadable post-media-thumb" id="media-${safeContentId}" data-fileinfo="${safeFileInfo}" data-mimetype="${safeMime}" data-mediatype="${mediaType}" style="background-image:url('${att.thumbnail}');background-size:cover;background-position:center">
            <button class="media-load-btn media-load-overlay" onclick="loadPostMedia('${safeContentId}')">
              <span class="media-load-icon">${icon}</span>
              <span class="media-load-hint">Click to play</span>
            </button>
          </div>`;
        } else {
          mediaHTML += `<div class="post-media-item post-media-loadable" id="media-${safeContentId}" data-fileinfo="${safeFileInfo}" data-mimetype="${safeMime}" data-mediatype="${mediaType}">
            <button class="media-load-btn" onclick="loadPostMedia('${safeContentId}')">
              <span class="media-load-icon">${icon}</span>
              <span class="media-load-text">${escapeHtml(att.fileName || mediaType)}</span>
              <span class="media-load-hint">Click to load</span>
            </button>
          </div>`;
        }
      } else {
        mediaHTML += `<div class="post-media-item" style="display:flex;align-items:center;justify-content:center">
          <span class="subtle">${escapeHtml(att.type)}: ${escapeHtml(att.fileName || att.contentId?.slice(0, 8) || 'file')}</span>
        </div>`;
      }
    }
    mediaHTML += '</div>';
  }

  const safeAuthorId = escapeAttr(post.authorId);
  const safePostId = escapeAttr(post.postId);

  if (post.hidden) {
    return `<div class="post-card post-hidden" data-postid="${safePostId}">
      <div class="post-content subtle" style="text-align:center;padding:16px">
        [Content hidden due to reports] <a href="#" onclick="event.preventDefault();this.closest('.post-card').classList.remove('post-hidden');this.closest('.post-card').outerHTML=renderPostCard(Object.assign(${JSON.stringify({...post, hidden: false})}))" style="color:var(--accent)">Show anyway</a>
      </div>
    </div>`;
  }

  return `<div class="post-card" data-postid="${safePostId}">
    <div class="post-card-header">
      <canvas class="post-avatar" width="40" height="40" data-peerid="${safeAuthorId}" onclick="openPeerProfile('${safeAuthorId}')"></canvas>
      <div class="post-author-info">
        <div class="post-author-name" onclick="openPeerProfile('${safeAuthorId}')">${escapeHtml(authorName)}</div>
        <div class="post-time">${relativeTime(post.timestamp)}${post.visibility === 'friends' ? ' &middot; <span class="visibility-badge" title="Friends only">&#128101;</span>' : ''}</div>
      </div>
    </div>
    ${post.content ? `<div class="post-content">${renderContentWithGifs(post.content)}</div>` : ''}
    ${mediaHTML}
    <div class="post-actions">
      <button class="post-action-btn ${post.liked ? 'liked' : ''}" onclick="toggleLike('${safePostId}', ${!!post.liked})">
        ${post.liked ? '&#10084;' : '&#9825;'} ${post.likeCount || 0}
      </button>
      <button class="post-action-btn" onclick="openComments('${safePostId}')">
        &#128172; ${post.commentCount || 0}
      </button>
      <button class="post-action-btn" onclick="sharePost('${safePostId}')" title="Share to a friend">&#8618; Share</button>
      <button class="post-action-btn post-delete-btn" onclick="deletePost('${safePostId}', ${isMe})" title="${isMe ? 'Delete post' : 'Hide from feed'}">&#128465;</button>
      ${!isMe ? `<button class="post-action-btn" onclick="showReportModal('${safePostId}','post')" title="Report">&#9873;</button>` : ''}
    </div>
  </div>`;
}

// ─── Share Post to Contact ────────────────────────────────────────────────

async function sharePost(postId) {
  // Find the post
  const post = state.feedPosts.find(p => p.postId === postId);
  if (!post) { showToast('Post not found'); return; }

  // Get contacts to share with
  let contacts;
  try {
    contacts = await send('get_contacts');
  } catch { showToast('Failed to load contacts'); return; }

  if (!contacts || contacts.length === 0) {
    showToast('No contacts', 'Connect with peers first');
    return;
  }

  // Build picker modal
  let picker = document.getElementById('share-post-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'share-post-picker';
    picker.className = 'modal';
    document.body.appendChild(picker);
  }

  const authorName = post.authorName || post.authorId.slice(0, 12);
  const preview = post.content ? post.content.slice(0, 80) + (post.content.length > 80 ? '...' : '') : '(media post)';

  picker.innerHTML = `<div class="modal-content" style="max-width:400px">
    <h3>Share Post</h3>
    <div class="share-post-preview">
      <div class="share-preview-author">${escapeHtml(authorName)}</div>
      <div class="share-preview-text">${escapeHtml(preview)}</div>
    </div>
    <div class="share-contact-list">
      ${contacts.filter(c => c.peerId !== state.myPeerId).map(c => `
        <div class="share-contact-item" onclick="sendSharedPost('${escapeAttr(c.peerId)}', '${escapeAttr(c.displayName || c.peerId.slice(0, 12))}', '${escapeAttr(postId)}')">
          <span class="share-contact-name">${c.online ? '<span class="online-dot"></span>' : ''}${escapeHtml(c.displayName || c.peerId.slice(0, 12))}</span>
          <span class="share-send-icon">&#9656;</span>
        </div>
      `).join('')}
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn-secondary" onclick="document.getElementById('share-post-picker').classList.add('hidden')">Cancel</button>
    </div>
  </div>`;
  picker.classList.remove('hidden');
}

async function sendSharedPost(peerId, displayName, postId) {
  const post = state.feedPosts.find(p => p.postId === postId);
  if (!post) return;

  const authorName = post.authorName || post.authorId.slice(0, 12);
  let content = post.content || '';

  // Handle media-only posts
  if (!content && post.mediaAttachments && post.mediaAttachments.length > 0) {
    content = post.mediaAttachments.map(a =>
      a.type === 'voicenote' ? '\ud83c\udfa4 Voice note' :
      a.type === 'video' ? '\ud83c\udfa5 Video' :
      a.type === 'image' ? '\ud83d\uddbc Image' :
      a.type === 'audio' ? '\ud83c\udfb5 Audio' : 'Media'
    ).join(', ');
  }

  // Format as JSON so we can render it as a card on the receiving end
  const shareData = JSON.stringify({
    type: 'shared_post',
    authorName,
    authorId: post.authorId,
    content,
    timestamp: post.timestamp,
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
  });
  const shareText = shareData;

  try {
    await send('send_message', { to: peerId, text: shareText });
    document.getElementById('share-post-picker').classList.add('hidden');
    showToast('Shared!', `Post sent to ${displayName}`);
  } catch (e) {
    showToast('Share failed', e.message);
  }
}

// ─── Feed Filter & Algorithm ──────────────────────────────────────────────

let feedFilter = 'all'; // 'all' | 'friends' | 'trending'
let feedFriendIds = new Set();

function setFeedFilter(filter) {
  feedFilter = filter;
  document.querySelectorAll('.feed-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderFeed();
}

function applyFeedAlgorithm(items) {
  let filtered = [...items];

  // Filter by tab
  if (feedFilter === 'friends') {
    filtered = filtered.filter(item => {
      const authorId = item.type === 'post' ? item.data.authorId : item.data.creatorId;
      return feedFriendIds.has(authorId) || authorId === state.myPeerId;
    });
  }

  // Engagement score for ranking
  for (const item of filtered) {
    if (item.type === 'post') {
      const post = item.data;
      const age = (Date.now() - post.timestamp) / (1000 * 60 * 60); // hours
      const engagement = (post.likeCount || 0) * 3 + (post.commentCount || 0) * 5;
      const isFriend = feedFriendIds.has(post.authorId);
      const isSelf = post.authorId === state.myPeerId;

      // Score: engagement weighted, friend boost, recency decay
      item.score = engagement + (isFriend ? 10 : 0) + (isSelf ? 5 : 0) - (age * 0.5);
    } else {
      item.score = 0;
    }
  }

  if (feedFilter === 'trending') {
    // Sort by engagement score (highest first)
    filtered.sort((a, b) => (b.score || 0) - (a.score || 0));
  } else {
    // Default: chronological but with diversity mixing
    // Don't show more than 3 consecutive posts from the same author
    filtered = diversityMix(filtered);
  }

  return filtered;
}

function diversityMix(items) {
  if (items.length <= 3) return items;

  // First sort chronologically
  items.sort((a, b) => b.timestamp - a.timestamp);

  const result = [];
  const deferred = [];
  let lastAuthor = null;
  let consecutiveCount = 0;

  for (const item of items) {
    const authorId = item.type === 'post' ? item.data.authorId : item.data.creatorId;
    if (authorId === lastAuthor) {
      consecutiveCount++;
      if (consecutiveCount >= 3) {
        deferred.push(item);
        continue;
      }
    } else {
      consecutiveCount = 1;
      lastAuthor = authorId;
    }
    result.push(item);
  }

  // Append deferred items at the end
  result.push(...deferred);
  return result;
}

let postVisibility = 'public';

function togglePostVisibility() {
  const btn = document.getElementById('post-visibility-toggle');
  if (postVisibility === 'public') {
    postVisibility = 'friends';
    btn.innerHTML = '&#128101; Friends';
    btn.title = 'Visible to friends only';
  } else {
    postVisibility = 'public';
    btn.innerHTML = '&#127758; Public';
    btn.title = 'Visible to everyone';
  }
}

// ─── Content Reporting ───────────────────────────────────────────────────────

let reportTarget = { contentId: '', contentType: '' };

function showReportModal(contentId, contentType) {
  reportTarget = { contentId, contentType };
  const modal = document.getElementById('report-modal');
  if (!modal) {
    // Create modal dynamically
    const div = document.createElement('div');
    div.id = 'report-modal';
    div.className = 'modal';
    div.innerHTML = `<div class="modal-content" style="max-width:400px">
      <h3>Report Content</h3>
      <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
        <label><input type="radio" name="report-reason" value="spam" checked> Spam</label>
        <label><input type="radio" name="report-reason" value="harassment"> Harassment</label>
        <label><input type="radio" name="report-reason" value="illegal"> Illegal content</label>
        <label><input type="radio" name="report-reason" value="other"> Other</label>
      </div>
      <textarea id="report-detail" placeholder="Additional details (optional)" rows="2" style="width:100%;resize:vertical;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);padding:8px"></textarea>
      <div class="modal-actions" style="margin-top:12px">
        <button class="btn-secondary" onclick="document.getElementById('report-modal').classList.add('hidden')">Cancel</button>
        <button class="btn-primary" onclick="submitReport()">Report</button>
      </div>
    </div>`;
    document.body.appendChild(div);
  } else {
    modal.classList.remove('hidden');
  }
  document.getElementById('report-modal').classList.remove('hidden');
}

async function submitReport() {
  const reason = document.querySelector('input[name="report-reason"]:checked')?.value || 'other';
  const detail = document.getElementById('report-detail')?.value || '';
  try {
    const result = await send('report_content', {
      contentId: reportTarget.contentId,
      contentType: reportTarget.contentType,
      reason,
      detail,
    });
    document.getElementById('report-modal').classList.add('hidden');
    showToast('Reported', result.hidden ? 'Content will be hidden from feeds' : 'Thank you for your report', 'success');
    if (result.hidden) {
      // Hide the post card in the DOM
      const card = document.querySelector(`[data-postid="${reportTarget.contentId}"]`);
      if (card) card.innerHTML = '<div class="post-content subtle" style="text-align:center;padding:16px">[Content hidden due to reports]</div>';
    }
  } catch (e) {
    showToast('Report Failed', e.message, 'error');
  }
}

async function createPost() {
  const input = document.getElementById('post-input');
  const content = input.value.trim();
  if (!content && state.postAttachments.length === 0) return;
  if (content.length > 2000) { showToast('Post too long (max 2000 chars)'); return; }

  const btn = document.getElementById('btn-post');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0"></div>'; }
  try {
    await send('create_post', { content, attachments: state.postAttachments, visibility: postVisibility });
    input.value = '';
    document.getElementById('char-counter').textContent = '0/2000';
    state.postAttachments = [];
    document.getElementById('composer-attachments').classList.add('hidden');
    document.getElementById('composer-attachments').innerHTML = '';
    loadFeed();
    showToast('Posted!');
  } catch (e) { showToast('Failed to post', e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Post'; } }
}

async function deletePost(postId, isAuthor) {
  let scope = 'self';
  if (isAuthor) {
    const choice = await showConfirm('Delete for everyone? OK = Delete for everyone, Cancel = Delete for me only');
    scope = choice ? 'everyone' : 'self';
  } else {
    if (!await showConfirm('Delete this post from your feed?')) return;
  }
  try {
    await send('delete_post', { postId, scope });
    showToast('Post deleted');
    loadFeed();
  } catch (e) { showToast('Failed to delete', e.message); }
}

async function deleteMessage(messageId, timestamp, isMine) {
  // Determine scope: own messages get a choice, received messages are always "Delete for me"
  let scope = 'self';
  let peerId = null;
  if (isMine && state.activeChat && state.activeChat.type !== 'group' && !state.activeChannel) {
    const choice = await showConfirm('Delete for everyone? OK = Delete for everyone, Cancel = Delete for me only');
    scope = choice ? 'everyone' : 'self';
  }
  try {
    let conversationId;
    if (state.activeChannel) {
      conversationId = `hub:${state.activeChannel.hubId}:${state.activeChannel.channelId}`;
    } else if (state.activeChat) {
      conversationId = state.activeChat.id;
      // Extract the other peer's ID for DM deletion notifications
      if (scope === 'everyone' && state.activeChat.type !== 'group') {
        const parts = state.activeChat.id.split(':');
        peerId = parts.find(p => p !== state.myPeerId);
      }
    }
    if (!conversationId) return;
    await send('delete_message', { conversationId, messageId, timestamp, scope, peerId });
    // Remove from DOM or show placeholder
    const bubble = document.querySelector(`.message[data-msg-id="${messageId}"]`);
    if (bubble) {
      if (scope === 'everyone') {
        bubble.innerHTML = '<div class="msg-body" style="opacity:0.5;font-style:italic">Message deleted</div>';
      } else {
        bubble.style.transition = 'opacity 0.2s'; bubble.style.opacity = '0';
        setTimeout(() => bubble.remove(), 200);
      }
    }
  } catch (e) { showToast('Failed to delete', e.message); }
}

async function loadPostMedia(contentId) {
  const container = document.getElementById('media-' + contentId);
  if (!container) return;

  const fileInfo = JSON.parse(container.dataset.fileinfo || '{}');
  const mimeType = container.dataset.mimetype || 'application/octet-stream';
  const mediaType = container.dataset.mediatype || 'file';

  console.log('[Media] Loading:', contentId, 'fileInfo:', fileInfo, 'keys:', Object.keys(fileInfo));

  // Show loading state
  const btn = container.querySelector('.media-load-btn');
  if (btn) {
    btn.disabled = true;
    btn.querySelector('.media-load-hint').textContent = 'Loading...';
  }

  try {
    const result = await send('download_media', { fileInfo, mimeType });
    if (!result || !result.dataUrl) throw new Error('No data returned');

    if (mediaType === 'video') {
      container.innerHTML = `<video src="${result.dataUrl}" controls style="max-width:100%;max-height:400px;border-radius:8px"></video>`;
    } else if (mediaType === 'image') {
      container.innerHTML = `<img src="${result.dataUrl}" alt="" style="max-width:100%;border-radius:8px">`;
    } else if (mediaType === 'audio') {
      container.innerHTML = `<audio src="${result.dataUrl}" controls style="width:100%"></audio>`;
    } else {
      // Generic file — offer download
      const a = document.createElement('a');
      a.href = result.dataUrl;
      a.download = fileInfo.fileName || 'download';
      a.click();
      if (btn) { btn.disabled = false; btn.querySelector('.media-load-hint').textContent = 'Downloaded!'; }
      return;
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.querySelector('.media-load-hint').textContent = 'Failed — tap to retry'; }
    showToast('Load failed', e.message, 'error');
  }
}

async function toggleLike(postId, isLiked) {
  try {
    if (isLiked) await send('unlike_post', { postId });
    else await send('like_post', { postId });
    // Don't call loadFeed() here — the post_interaction event will trigger it.
    // Calling both causes double full-DOM rebuild of the entire feed.
    loadFeed();
  } catch (e) { showToast('Failed', e.message); }
}

async function openComments(postId) {
  state.commentPostId = postId;
  const modal = document.getElementById('comments-modal');
  const list = document.getElementById('comments-list');
  list.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
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
          <div class="comment-body">${renderContentWithGifs(c.content)}</div>
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

    // Generate thumbnail for videos
    let thumbnail = type === 'image' ? dataUrl : undefined;
    if (type === 'video') {
      try { thumbnail = await generateVideoThumbnail(file); } catch {}
    }

    if (file.size <= INLINE_SIZE_LIMIT) {
      // Small file — inline base64
      state.postAttachments.push({
        type,
        contentId: crypto.randomUUID(),
        mimeType: file.type,
        thumbnail,
        data: dataUrl,
        fileName: file.name,
        fileSize: file.size,
      });
      renderAttachments();
    } else {
      // Large file — chunked upload through shard system
      showToast('Uploading...', `${file.name}`);
      try {
        const result = await uploadFileChunked(file, 'media');
        state.postAttachments.push({
          type,
          contentId: result.contentId,
          mimeType: file.type,
          thumbnail,
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

function generateVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;
    video.onloadeddata = () => {
      video.currentTime = Math.min(1, video.duration * 0.1); // grab frame at 10% or 1s
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(video.videoWidth, 640);
        canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const thumb = canvas.toDataURL('image/jpeg', 0.7);
        URL.revokeObjectURL(url);
        resolve(thumb);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video load failed')); };
    // Timeout fallback
    setTimeout(() => { URL.revokeObjectURL(url); reject(new Error('Thumbnail timeout')); }, 10000);
  });
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

  // 1. Try cached blob/dataURL first (instant playback for own recordings)
  let blob = vnBlobCache.get(contentId);
  // Lazy decode: if cache has a data URL string, convert to Blob now (on play, not on render)
  if (blob && typeof blob === 'string') {
    blob = dataUrlToBlob(blob);
    vnBlobCache.set(contentId, blob); // replace with decoded blob for future plays
  }

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
  if (!chatVnBlob || (!state.activeChat && !state.activeChannel)) return;

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
      if (state.activeChannel) {
        await send('send_hub_message', { hubId: state.activeChannel.hubId, channelId: state.activeChannel.channelId, text: msgBody });
      } else if (state.activeChat.type === 'dm') {
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
function renderVoicenoteMessageHTML(isMine, vn, time, senderHTML, msgId) {
  const hasWaveform = vn.waveform && vn.waveform.length > 0;
  const safeId = escapeAttr(vn.contentId);
  const safeWaveform = hasWaveform ? escapeAttr(JSON.stringify(vn.waveform)) : '';
  return `
    <div class="message ${isMine ? 'sent' : 'received'}" ${msgId ? `id="${msgId}"` : ''}>
      ${senderHTML || ''}
      <div class="voicenote-player">
        <button class="vn-play-btn" onclick="playVoicenote('${safeId}')">&#9654;</button>
        ${hasWaveform
          ? `<canvas class="vn-waveform-display" data-contentid="${safeId}" data-waveform="${safeWaveform}" width="200" height="30"></canvas>`
          : `<div class="vn-bar"></div>`}
        <span class="vn-duration">${vn.duration ? formatDuration(vn.duration) : '--:--'}</span>
      </div>
      <div class="msg-time">${time}
        <span class="msg-crypto-status crypto-encrypting"><span class="status-dot-sm"></span>${isMine ? 'ENCRYPTING' : 'DECRYPTING'}</span>
      </div>
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
  const msgId = 'vn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  el.innerHTML += renderVoicenoteMessageHTML(isMine, msg.voicenote, time, senderHTML, msgId);
  // Draw waveform on new canvas
  requestAnimationFrame(() => {
    const canvas = el.querySelector(`canvas.vn-waveform-display[data-contentid="${msg.voicenote.contentId}"]`);
    if (canvas) {
      try { drawPostWaveform(canvas, JSON.parse(canvas.dataset.waveform), 0); } catch (e) {}
    }
    // Trigger audio encryption animation
    const msgEl = document.getElementById(msgId);
    if (msgEl) {
      animateAudioCrypto(msgEl, isMine);
    }
  });
  // Store in messages for findVoicenoteAttachment lookup
  state.messages.push(msg);
  if (scrollDown) scrollToBottom();
}

// Audio encryption/decryption animation
async function animateAudioCrypto(msgEl, isSend) {
  const player = msgEl.querySelector('.voicenote-player');
  const statusEl = msgEl.querySelector('.msg-crypto-status');
  const waveCanvas = msgEl.querySelector('.vn-waveform-display');
  const playBtn = msgEl.querySelector('.vn-play-btn');
  if (!player) return;

  // Insert compact pipeline above the player
  const pipelineHTML = `<div class="audio-crypto-pipeline">
    <span class="acp-step" data-s="key">X25519</span>
    <span class="acp-arrow">&#9654;</span>
    <span class="acp-step" data-s="enc">${isSend ? 'ENCRYPT' : 'DECRYPT'}</span>
    <span class="acp-arrow">&#9654;</span>
    <span class="acp-step" data-s="sign">${isSend ? 'SIGN' : 'VERIFY'}</span>
    <span class="acp-label">AUDIO STREAM // AES-256-GCM</span>
  </div>`;
  player.insertAdjacentHTML('beforebegin', pipelineHTML);
  const pipeline = msgEl.querySelector('.audio-crypto-pipeline');

  // Disable play during animation
  if (playBtn) playBtn.disabled = true;

  // Scramble waveform if present
  let waveformData = null;
  if (waveCanvas && waveCanvas.dataset.waveform) {
    try { waveformData = JSON.parse(waveCanvas.dataset.waveform); } catch {}
  }

  // Step 1: Key exchange
  const keyStep = pipeline.querySelector('[data-s="key"]');
  keyStep.classList.add('active');
  if (statusEl) { statusEl.innerHTML = '<span class="status-dot-sm"></span>KEY EXCHANGE'; statusEl.className = 'msg-crypto-status crypto-encrypting'; }
  await new Promise(r => setTimeout(r, 350));
  cryptoSfx.lock();
  keyStep.classList.remove('active');
  keyStep.classList.add('done');

  // Step 2: Encrypt/Decrypt with waveform scramble
  const encStep = pipeline.querySelector('[data-s="enc"]');
  encStep.classList.add('active');
  if (statusEl) { statusEl.innerHTML = `<span class="status-dot-sm"></span>${isSend ? 'ENCRYPTING' : 'DECRYPTING'}`; }

  // Animate waveform scramble/reveal
  if (waveCanvas && waveformData) {
    const ctx = waveCanvas.getContext('2d');
    const w = waveCanvas.width;
    const h = waveCanvas.height;
    const steps = 12;

    for (let s = 0; s < steps; s++) {
      const frac = isSend ? (s / steps) : (1 - s / steps);
      ctx.clearRect(0, 0, w, h);
      const barW = w / waveformData.length;
      for (let i = 0; i < waveformData.length; i++) {
        const realH = waveformData[i] * h * 0.8;
        const noiseH = (Math.random() * 0.8 + 0.1) * h * 0.8;
        const barH = realH * (1 - frac) + noiseH * frac;
        const x = i * barW;
        const y = (h - barH) / 2;
        ctx.fillStyle = frac > 0.5 ? 'rgba(50, 224, 196, 0.4)' : 'rgba(50, 224, 196, 0.6)';
        ctx.fillRect(x + 0.5, y, Math.max(barW - 1, 1), barH);
      }
      if (s % 2 === 0) cryptoSfx.tick();
      await new Promise(r => setTimeout(r, 60));
    }
  } else {
    await new Promise(r => setTimeout(r, 600));
  }

  cryptoSfx.lock();
  encStep.classList.remove('active');
  encStep.classList.add('done');

  // Step 3: Sign/Verify
  const signStep = pipeline.querySelector('[data-s="sign"]');
  signStep.classList.add('active');
  if (statusEl) { statusEl.innerHTML = `<span class="status-dot-sm"></span>${isSend ? 'SIGNING' : 'VERIFYING'}`; }
  await new Promise(r => setTimeout(r, 300));
  cryptoSfx.lock();
  signStep.classList.remove('active');
  signStep.classList.add('done');

  // Restore waveform
  if (waveCanvas && waveformData) {
    drawPostWaveform(waveCanvas, waveformData, 0);
  }

  // Final status
  msgEl.classList.add('crypto-locked');
  if (statusEl) {
    statusEl.innerHTML = `<span class="status-dot-sm"></span>${isSend ? 'DELIVERED' : 'DECRYPTED'}`;
    statusEl.className = `msg-crypto-status ${isSend ? 'crypto-delivered' : 'crypto-decrypted'}`;
  }
  if (playBtn) playBtn.disabled = false;

  await new Promise(r => setTimeout(r, 400));
  msgEl.classList.remove('crypto-locked');

  // Fade out pipeline
  pipeline.style.opacity = '0';
  pipeline.style.transition = 'opacity 0.3s';
  await new Promise(r => setTimeout(r, 300));
  pipeline.remove();
}

// ─── WebRTC Voice/Video Calls ───────────────────────────────────────────────

// ─── Audio Processing (Noise Suppression + Gate) ─────────────────────────────

const AUDIO_CONSTRAINTS = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
};

let noiseGateEnabled = true;
const NOISE_GATE_THRESHOLD = -50; // dB — audio below this is silenced
let noiseGateNode = null;

function getAudioConstraints(includeVideo) {
  return {
    audio: AUDIO_CONSTRAINTS,
    video: includeVideo || false,
  };
}

// Apply noise gate to an audio stream — returns processed stream
function applyNoiseGate(stream) {
  if (!noiseGateEnabled) return stream;

  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    // Mic volume gain
    const micGain = ctx.createGain();
    micGainNode = micGain;
    const micVol = document.getElementById('call-mic-vol');
    if (micVol) micGain.gain.value = parseInt(micVol.value) / 100;
    // Noise gate gain
    const gateGain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();

    source.connect(micGain);
    micGain.connect(analyser);
    micGain.connect(gateGain);
    gateGain.connect(destination);
    const gainNode = gateGain;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Monitor audio level and gate
    const gateInterval = setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length;
      // Convert to rough dB scale (0-255 → -100 to 0 dB)
      const dB = avg > 0 ? 20 * Math.log10(avg / 255) : -100;

      if (dB < NOISE_GATE_THRESHOLD) {
        // Below threshold — fade to silence quickly
        gainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      } else {
        // Above threshold — open gate
        gainNode.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
      }
    }, 20); // Check every 20ms

    // Store cleanup reference
    noiseGateNode = { ctx, interval: gateInterval, stream: destination.stream };

    // Copy video tracks if present
    for (const track of stream.getVideoTracks()) {
      destination.stream.addTrack(track);
    }

    return destination.stream;
  } catch (e) {
    console.warn('[Audio] Noise gate failed, using raw stream:', e.message);
    return stream;
  }
}

// ─── Volume Controls ─────────────────────────────────
let micGainNode = null;
let speakerGainNode = null;
let speakerCtx = null;

function setMicVolume(val) {
  const pct = parseInt(val);
  document.getElementById('mic-vol-val').textContent = pct + '%';
  if (micGainNode) micGainNode.gain.value = pct / 100;
}

function setSpeakerVolume(val) {
  const pct = parseInt(val);
  document.getElementById('speaker-vol-val').textContent = pct + '%';
  // Adjust all remote audio/video elements
  document.querySelectorAll('#remote-video, audio[id^="voice-audio-"]').forEach(el => {
    el.volume = pct / 100;
  });
}

function cleanupNoiseGate() {
  if (noiseGateNode) {
    clearInterval(noiseGateNode.interval);
    try { noiseGateNode.ctx.close(); } catch {}
    noiseGateNode = null;
  }
  micGainNode = null;
}

const ICE_SERVERS_FULL = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:188.166.151.203:3478', username: 'opendescent', credential: 'Od3sc3nt2025!' },
  { urls: 'turn:188.166.151.203:3478?transport=tcp', username: 'opendescent', credential: 'Od3sc3nt2025!' },
];

const ICE_SERVERS_P2P_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function getIceServers() {
  return state.directCallsOnly ? ICE_SERVERS_P2P_ONLY : ICE_SERVERS_FULL;
}

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
    const rawStream = await navigator.mediaDevices.getUserMedia(getAudioConstraints(type === 'video'));
    state.localStream = applyNoiseGate(rawStream);
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
  state.peerConnection = new RTCPeerConnection({ iceServers: getIceServers() });
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
    if (cs === 'connected') { state.callState = 'connected'; state.callTransport = 'webrtc'; sfx.play('callConnect'); updateCallStatus('Connected'); startCallTimer(); }
    else if (cs === 'failed') { attemptRelayFallback(); }
    else if (cs === 'disconnected' || cs === 'closed') endCall();
  };
}

async function onCallSignal(data) {
  const signal = data.signal;
  // Route voice channel signals
  if (signal.type && signal.type.startsWith('voice_')) {
    handleVoiceSignal(data);
    return;
  }
  if (signal.type === 'offer') {
    state.callPeerId = data.from; state.callPeerName = data.fromName; state.callType = signal.callType || 'voice'; state.callState = 'incoming'; state.iceCandidateQueue = []; state.pendingOffer = signal;
    sfx.play('callIncoming');
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
  } else if (signal.type === 'typing') {
    onTypingReceived(data.from, data.fromName);
    return;
  } else if (signal.type === 'switch-to-relay') {
    // Remote peer's WebRTC failed — switch to relay audio
    if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }
    try {
      const result = await send('start_relay_audio', { peerId: state.callPeerId });
      if (result.started) {
        state.callTransport = 'relay';
        state.callState = 'connected';
        updateCallStatus('Connected (relay)');
        if (!state.callTimer) startCallTimer();
        await startRelayAudioCapture();
        startRelayAudioPlayback();
      }
    } catch (e) { showToast('Relay fallback failed', e.message); endCall(); }
  } else if (signal.type === 'hangup') endCall();
}

function openCallChat() {
  if (state.callPeerId) {
    startDM(state.callPeerId, state.callPeerName || state.callPeerId.slice(0, 12));
  }
}

// ─── Relay Audio Fallback ─────────────────────────────────────────────────

async function attemptRelayFallback() {
  if (!state.callPeerId || state.callTransport === 'relay') return;
  updateCallStatus('Direct failed — switching to relay...');

  if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }

  try {
    const result = await send('start_relay_audio', { peerId: state.callPeerId });
    if (!result.started) throw new Error('Backend refused relay audio');

    state.callTransport = 'relay';
    state.callState = 'connected';
    updateCallStatus('Connected (relay)');
    startCallTimer();
    sfx.play('callConnect');

    // Tell the other peer to switch too
    await send('call_signal', { peerId: state.callPeerId, signal: { type: 'switch-to-relay' } });

    await startRelayAudioCapture();
    startRelayAudioPlayback();
  } catch (e) {
    showToast('Call failed', 'Could not establish relay connection');
    endCall();
  }
}

async function startRelayAudioCapture() {
  if (!state.localStream) {
    const rawRelay = await navigator.mediaDevices.getUserMedia(getAudioConstraints(false));
    state.localStream = applyNoiseGate(rawRelay);
  }

  const ctx = new AudioContext({ sampleRate: 48000 });
  state.relayAudioContext = ctx;

  await ctx.audioWorklet.addModule('audio-capture-worklet.js');
  const source = ctx.createMediaStreamSource(state.localStream);
  const captureNode = new AudioWorkletNode(ctx, 'audio-capture-processor');
  state.relayAudioWorklet = captureNode;
  source.connect(captureNode);

  captureNode.port.onmessage = (event) => {
    const mulawBytes = event.data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.relayAudioActive) {
      const peerIdBytes = new TextEncoder().encode(state.callPeerId);
      const frame = new Uint8Array(1 + peerIdBytes.length + mulawBytes.length);
      frame[0] = peerIdBytes.length;
      frame.set(peerIdBytes, 1);
      frame.set(mulawBytes, 1 + peerIdBytes.length);
      state.ws.send(frame.buffer);
    }
  };

  state.relayAudioActive = true;
}

async function startRelayAudioPlayback() {
  if (!state.relayAudioContext) {
    state.relayAudioContext = new AudioContext({ sampleRate: 48000 });
  }
  const ctx = state.relayAudioContext;

  await ctx.audioWorklet.addModule('audio-playback-worklet.js');
  const playbackNode = new AudioWorkletNode(ctx, 'audio-playback-processor');
  state.relayPlaybackWorklet = playbackNode;
  playbackNode.connect(ctx.destination);
}

function handleRelayAudioChunk(buffer) {
  if (!state.relayPlaybackWorklet) return;
  const view = new Uint8Array(buffer);
  if (view.length < 3) return;
  const peerIdLen = view[0];
  const audioData = view.subarray(1 + peerIdLen);
  state.relayPlaybackWorklet.port.postMessage(audioData);
}

function endCall() {
  sfx.play('callEnd');
  if (state.callPeerId && state.callState) {
    send('call_signal', { peerId: state.callPeerId, signal: { type: 'hangup' } }).catch(() => {});
    if (state.relayAudioActive) {
      send('stop_relay_audio', { peerId: state.callPeerId }).catch(() => {});
    }
  }
  if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }
  if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }
  // Clean up relay audio
  if (state.relayAudioWorklet) { state.relayAudioWorklet.disconnect(); state.relayAudioWorklet = null; }
  if (state.relayPlaybackWorklet) { state.relayPlaybackWorklet.disconnect(); state.relayPlaybackWorklet = null; }
  if (state.relayAudioContext) { state.relayAudioContext.close().catch(() => {}); state.relayAudioContext = null; }
  state.relayAudioActive = false;
  state.callTransport = null;
  cleanupNoiseGate();
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
    const rawAccept = await navigator.mediaDevices.getUserMedia(getAudioConstraints(state.callType === 'video'));
    state.localStream = applyNoiseGate(rawAccept);
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

function updateCallStatus(text) {
  document.getElementById('call-status').textContent = text;
  const transportEl = document.getElementById('call-transport');
  if (transportEl) {
    if (state.callTransport === 'relay') {
      transportEl.textContent = 'RELAY';
      transportEl.className = 'relay';
    } else if (state.callTransport === 'webrtc') {
      transportEl.textContent = 'P2P';
      transportEl.className = 'direct';
    } else {
      transportEl.className = 'hidden';
    }
  }
}

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
  else if (tabName === 'deaddrops') { showView('deaddrops'); loadDeadDrops(); }
  else if (tabName === 'discover') { loadFriendRequests(); searchPeers(); send('discover_network', {}).catch(() => {}); }
  else if (tabName === 'chats' || tabName === 'contacts' || tabName === 'groups') {
    if (!state.activeChat) showView('empty');
  }
}

function toggleNoiseGate(enabled) {
  noiseGateEnabled = enabled;
  try { localStorage.setItem('noiseGateEnabled', enabled ? '1' : '0'); } catch {}
  showToast(enabled ? 'Noise Gate On' : 'Noise Gate Off', enabled ? 'Background noise will be suppressed' : 'All audio passes through');
}

// Load noise gate preference
try { noiseGateEnabled = localStorage.getItem('noiseGateEnabled') !== '0'; } catch {}

function toggleDirectCalls(enabled) {
  state.directCallsOnly = enabled;
  try { localStorage.setItem('directCallsOnly', enabled ? '1' : '0'); } catch {}
  showToast(enabled ? 'Direct P2P Only' : 'Relay Enabled', enabled ? 'Calls require direct connection' : 'Calls will use encrypted relay when needed');
}

// Load direct calls preference
try { state.directCallsOnly = localStorage.getItem('directCallsOnly') === '1'; } catch {}

function setConnectionStatus(status) {
  const dot = document.getElementById('connection-status');
  dot.className = `status-dot ${status}`;
  state.connected = status === 'online';
  const microStatus = document.getElementById('micro-status');
  if (microStatus) {
    microStatus.textContent = status === 'online' ? 'SIGNAL LOCKED' : status === 'connecting' ? 'ACQUIRING...' : 'NO SIGNAL';
    microStatus.style.color = status === 'online' ? 'var(--accent)' : status === 'connecting' ? 'var(--orange)' : 'var(--red)';
  }
}

function scrollToBottom() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
  // Scroll again after animations expand (cipher machine, route strip)
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  setTimeout(() => { container.scrollTop = container.scrollHeight; }, 150);
  setTimeout(() => { container.scrollTop = container.scrollHeight; }, 400);
}

function showToast(title, body, type) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  const typeClass = type ? ' toast-' + type : ' toast-info';
  toast.className = 'toast' + typeClass;
  toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}`;
  toast.onclick = () => {
    toast.classList.add('toast-dismiss');
    setTimeout(() => toast.remove(), 200);
  };
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('toast-dismiss');
      setTimeout(() => toast.remove(), 200);
    }
  }, 4000);
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

// ─── GIF Library (Klipy) ─────────────────────────────────────────────────────

function isGifUrl(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.includes('\n') || t.includes(' ')) return false;
  return t.includes('klipy.com') || /\.(gif|webp)(\?.*)?$/i.test(t);
}

function isGifLine(line) {
  if (!line) return false;
  const t = line.trim();
  if (!t || t.includes(' ')) return false;
  return (t.startsWith('http') && (t.includes('klipy.com') || /\.(gif|webp)(\?.*)?$/i.test(t)));
}

function renderContentWithGifs(text) {
  if (!text) return '';

  // Detect shared post card
  try {
    if (text.startsWith('{"type":"shared_post"')) {
      const shared = JSON.parse(text);
      if (shared.type === 'shared_post') {
        const time = relativeTime(shared.timestamp);
        return `<div class="shared-post-card">
          <div class="shared-post-label">&#8618; SHARED POST</div>
          <div class="shared-post-author">${escapeHtml(shared.authorName)}</div>
          <div class="shared-post-content">${linkify(escapeHtml(shared.content))}</div>
          <div class="shared-post-meta">${time} &middot; &#9825; ${shared.likeCount || 0} &middot; &#128172; ${shared.commentCount || 0}</div>
        </div>`;
      }
    }
  } catch {}

  const lines = text.split('\n');
  return lines.map(line => {
    if (isGifLine(line)) {
      return `<img class="gif-message" src="${escapeAttr(line.trim())}" alt="GIF" loading="lazy">`;
    }
    return linkify(escapeHtml(line));
  }).join('<br>');
}

function linkify(escapedHtml) {
  // Match URLs in already-escaped HTML text
  const urlRegex = /(https?:\/\/[^\s<>&"']+)/g;
  return escapedHtml.replace(urlRegex, (url) => {
    const decoded = url.replace(/&amp;/g, '&');
    return `<a href="#" class="msg-link" onclick="event.preventDefault(); openExternalLink('${escapeAttr(decoded)}')" title="${escapeAttr(decoded)}">${url}</a>`;
  });
}

function openExternalLink(url) {
  showConfirm(`Open external link?\n\n${url}\n\nThis will open in your browser. OpenDescent cannot guarantee the safety of external sites.`).then(confirmed => {
    if (confirmed) window.open(url, '_blank', 'noopener,noreferrer');
  });
}

let _gifPickerContext = null; // 'post' | 'chat' | 'hub'
let _gifSearchTimer = null;
let _gifCategories = null;

function showGifPicker(context, anchorEl) {
  _gifPickerContext = context;
  let picker = document.getElementById('gif-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'gif-picker';
    picker.innerHTML = `
      <div class="gif-picker-header">
        <input type="text" id="gif-search-input" placeholder="Search GIFs..." autocomplete="off">
        <button class="gif-picker-close" onclick="closeGifPicker()">&times;</button>
      </div>
      <div class="gif-categories" id="gif-categories"></div>
      <div class="gif-results" id="gif-results"></div>
      <div class="gif-attribution">Powered by Klipy</div>
    `;
    document.body.appendChild(picker);
    // Wire search input with debounce
    const input = picker.querySelector('#gif-search-input');
    input.addEventListener('input', () => {
      clearTimeout(_gifSearchTimer);
      _gifSearchTimer = setTimeout(() => {
        const q = input.value.trim();
        if (q) searchGifs(q);
        else loadTrendingGifs();
      }, 300);
    });
  }
  // Position near anchor — prefer above button, fall back to below, clamp to viewport
  picker.style.top = 'auto';
  picker.style.bottom = 'auto';
  picker.style.left = 'auto';
  picker.style.right = 'auto';
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const pickerH = 420; // max-height
    const pickerW = 380;
    const margin = 8;
    // Horizontal: clamp to viewport
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - pickerW - margin));
    picker.style.left = left + 'px';
    // Vertical: prefer above, fall back to below
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    if (spaceAbove >= pickerH || spaceAbove >= spaceBelow) {
      // Place above button, clamp top to viewport
      const top = Math.max(margin, rect.top - pickerH);
      picker.style.top = top + 'px';
      picker.style.maxHeight = (rect.top - top) + 'px';
    } else {
      // Place below button
      picker.style.top = (rect.bottom + margin) + 'px';
      picker.style.maxHeight = Math.min(pickerH, spaceBelow) + 'px';
    }
  } else {
    picker.style.bottom = '60px';
    picker.style.right = '20px';
  }
  picker.classList.remove('hidden');
  picker.querySelector('#gif-search-input').value = '';
  picker.querySelector('#gif-search-input').focus();
  loadGifCategories();
  loadTrendingGifs();
}

function closeGifPicker() {
  const picker = document.getElementById('gif-picker');
  if (picker) picker.classList.add('hidden');
  _gifPickerContext = null;
}

async function searchGifs(query) {
  const results = document.getElementById('gif-results');
  if (!results) return;
  results.innerHTML = '<div class="gif-loading">Searching...</div>';
  try {
    const data = await send('gif_search', { q: query, per_page: 24 });
    renderGifResults(data);
  } catch (e) {
    results.innerHTML = '<div class="gif-loading">Failed to search. Check API key in Settings.</div>';
  }
}

async function loadTrendingGifs() {
  const results = document.getElementById('gif-results');
  if (!results) return;
  results.innerHTML = '<div class="gif-loading">Loading trending...</div>';
  try {
    const data = await send('gif_trending', { per_page: 24 });
    renderGifResults(data);
  } catch (e) {
    results.innerHTML = '<div class="gif-loading">Set your Klipy API key in Settings to use GIFs.</div>';
  }
}

async function loadGifCategories() {
  const el = document.getElementById('gif-categories');
  if (!el) return;
  if (_gifCategories) {
    renderGifCategoryChips(_gifCategories);
    return;
  }
  try {
    const data = await send('gif_categories');
    _gifCategories = data?.categories || data || [];
    renderGifCategoryChips(_gifCategories);
  } catch {
    el.innerHTML = '';
  }
}

function renderGifCategoryChips(categories) {
  const el = document.getElementById('gif-categories');
  if (!el || !categories) return;
  const chips = categories.slice(0, 8).map(c => {
    const name = typeof c === 'string' ? c : (c.name || c.searchterm || '');
    return `<button class="gif-category-chip" onclick="searchGifs('${escapeAttr(name)}')">${escapeHtml(name)}</button>`;
  });
  el.innerHTML = chips.join('');
}

function renderGifResults(data) {
  const el = document.getElementById('gif-results');
  if (!el) return;
  // Backend now sends { gifs: [...] } after unwrapping Klipy response
  const gifs = data?.gifs || data?.results || data?.data || [];
  if (!Array.isArray(gifs) || gifs.length === 0) {
    el.innerHTML = '<div class="gif-loading">No GIFs found</div>';
    return;
  }
  el.innerHTML = gifs.map(g => {
    const thumb = g.file?.sm?.webp?.url || g.file?.sm?.gif?.url || g.file?.xs?.webp?.url || '';
    const full = g.file?.md?.gif?.url || g.file?.md?.webp?.url || g.file?.hd?.gif?.url || thumb;
    if (!thumb) return '';
    return `<div class="gif-item" onclick="selectGif('${escapeAttr(full)}')">
      <img src="${escapeAttr(thumb)}" alt="GIF" loading="lazy">
    </div>`;
  }).join('');
}

function selectGif(url) {
  const context = _gifPickerContext;
  closeGifPicker();
  if (context === 'chat' || context === 'hub') {
    // Send GIF as a message
    const input = document.getElementById('message-input');
    if (input) input.value = url;
    document.getElementById('btn-send').click();
  } else if (context === 'post') {
    // Add GIF URL to post content
    const postInput = document.getElementById('post-input');
    if (postInput) {
      postInput.value = (postInput.value ? postInput.value + '\n' : '') + url;
      postInput.dispatchEvent(new Event('input'));
    }
  } else if (context === 'hub-icon-create') {
    const iconInput = document.getElementById('hub-icon-input');
    if (iconInput) iconInput.value = url;
    updateHubIconPreview('hub-icon-preview', url);
  } else if (context === 'hub-icon-edit') {
    const iconInput = document.getElementById('hs-icon');
    if (iconInput) iconInput.value = url;
    updateHubIconPreview('hs-icon-preview', url);
  } else if (context === 'avatar') {
    state.pendingAvatarUrl = url;
    updateAvatarPreview(url);
  }
}

function updateHubIconPreview(previewId, value) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  if (value && (value.startsWith('http://') || value.startsWith('https://'))) {
    preview.innerHTML = `<img src="${escapeAttr(value)}" alt="Hub icon">`;
    preview.classList.remove('hidden');
  } else if (value) {
    preview.innerHTML = escapeHtml(value);
    preview.classList.remove('hidden');
  } else {
    preview.innerHTML = '';
    preview.classList.add('hidden');
  }
}

function isUrlIcon(icon) {
  return icon && (icon.startsWith('http://') || icon.startsWith('https://'));
}

function renderHubIcon(icon, fallbackName, cssClass) {
  if (isUrlIcon(icon)) {
    return `<img src="${escapeAttr(icon)}" alt="Hub" class="${cssClass}">`;
  }
  return escapeAttr(icon || (fallbackName || '?').charAt(0).toUpperCase());
}

// GIF API key management
// ─── License / Pro Tier ──────────────────────────────────────────────────

async function loadLicenseStatus() {
  try {
    const data = await send('get_license_status');
    state.licenseStatus = data;
    updateLicenseUI(data);
  } catch {}
}

function updateLicenseUI(data) {
  const freeBanner = document.getElementById('license-free-banner');
  const proBanner = document.getElementById('license-pro-banner');
  if (!freeBanner || !proBanner) return;

  if (data && data.valid && data.tier === 'pro') {
    freeBanner.classList.add('hidden');
    proBanner.classList.remove('hidden');
    const expiryEl = document.getElementById('license-expiry-date');
    if (expiryEl && data.expiresAt) {
      expiryEl.textContent = new Date(data.expiresAt).toLocaleDateString();
    }
  } else {
    freeBanner.classList.remove('hidden');
    proBanner.classList.add('hidden');
  }
}

async function activateLicense() {
  const input = document.getElementById('setting-license-key');
  if (!input) return;
  const key = input.value.trim();
  if (!key) { showToast('License', 'Please paste your license key', 'error'); return; }
  try {
    const data = await send('activate_license', { licenseKey: key });
    state.licenseStatus = data;
    updateLicenseUI(data);
    input.value = '';
    showToast('Pro Activated!', 'Welcome to OpenDescent Pro', 'success');
  } catch (e) {
    showToast('Activation Failed', e.message, 'error');
  }
}

async function upgradeToPro() {
  try {
    const data = await send('get_checkout_url');
    if (!data || !data.checkoutUrl) {
      showToast('Error', 'Could not start checkout', 'error');
      return;
    }
    window.open(data.checkoutUrl, '_blank');
    showToast('Checkout opened', 'Complete payment in the new tab, then paste your license key here', 'success');
  } catch (e) {
    showToast('Checkout Error', e.message, 'error');
  }
}

async function saveGifApiKey() {
  const keyInput = document.getElementById('setting-gif-api-key');
  if (!keyInput) return;
  const apiKey = keyInput.value.trim();
  if (!apiKey) return;
  try {
    await send('set_gif_api_key', { apiKey });
    showToast('API Key Saved', 'GIF library is ready', 'success');
    // Mask the key
    keyInput.value = apiKey.slice(0, 4) + '...' + apiKey.slice(-4);
    keyInput.type = 'text';
  } catch (e) {
    showToast('Save Failed', e.message, 'error');
  }
}

async function loadGifApiKey() {
  const keyInput = document.getElementById('setting-gif-api-key');
  if (!keyInput) return;
  try {
    const data = await send('get_gif_api_key');
    if (data && data.maskedKey) {
      keyInput.value = data.maskedKey;
    } else {
      keyInput.value = '';
    }
  } catch {
    keyInput.value = '';
  }
}

// ─── Dead Drops ──────────────────────────────────────────────────────────────

async function loadDeadDrops() {
  try {
    const result = await send('get_dead_drops', { limit: 50 });
    state.deadDrops = result.drops || [];
    state.deadDropContents = result.contents || {};
    renderDeadDrops();
  } catch (e) {
    console.error('Failed to load dead drops:', e);
  }
}

function renderDeadDrops() {
  const feed = document.getElementById('deaddrop-feed');
  if (!feed) return;
  feed.innerHTML = '';

  let filtered = [...state.deadDrops];

  // Filter by zone
  if (activeDropZone !== 'all') {
    filtered = filtered.filter(d => (d.zone || 'signals') === activeDropZone);
  }

  // Separate top-level drops from replies
  const topLevel = filtered.filter(d => !d.parentDropId);
  const replies = filtered.filter(d => d.parentDropId);
  const replyMap = {};
  for (const r of replies) {
    if (!replyMap[r.parentDropId]) replyMap[r.parentDropId] = [];
    replyMap[r.parentDropId].push(r);
  }

  if (topLevel.length === 0) {
    const zoneText = activeDropZone === 'all' ? '' : ` in #${activeDropZone}`;
    feed.innerHTML = `<div class="empty-state-rich"><div class="empty-state-icon">&#128123;</div><div class="empty-state-text"><strong>The void is silent${zoneText}</strong>Drop something anonymous.</div></div>`;
    return;
  }

  // Sort: flares first, then by timestamp desc
  topLevel.sort((a, b) => {
    if (a.isFlare && !b.isFlare) return -1;
    if (!a.isFlare && b.isFlare) return 1;
    return b.timestamp - a.timestamp;
  });

  for (const drop of topLevel) {
    feed.appendChild(renderDeadDropCard(drop));
    // Render replies inline
    const dropReplies = replyMap[drop.dropId];
    if (dropReplies && dropReplies.length > 0) {
      const replyContainer = document.createElement('div');
      replyContainer.className = 'deaddrop-replies';
      dropReplies.sort((a, b) => a.timestamp - b.timestamp);
      for (const reply of dropReplies) {
        replyContainer.appendChild(renderDeadDropCard(reply, true));
      }
      feed.appendChild(replyContainer);
    }
  }
}

function renderDeadDropCard(drop, isReply) {
  const card = document.createElement('div');
  card.className = `deaddrop-card${drop.isFlare ? ' deaddrop-flare' : ''}${isReply ? ' deaddrop-reply' : ''}`;
  card.id = `deaddrop-${drop.dropId}`;

  const content = state.deadDropContents[drop.dropId] || '(encrypted)';
  const time = relativeTime(drop.timestamp);
  const expiresIn = drop.expiresAt - Date.now();
  const hoursLeft = Math.max(0, Math.floor(expiresIn / (60 * 60 * 1000)));
  const minsLeft = Math.max(0, Math.floor((expiresIn % (60 * 60 * 1000)) / (60 * 1000)));
  const expiryText = expiresIn > 0 ? `${hoursLeft}h ${minsLeft}m left` : 'Expired';

  const anonIcons = ['?', '!', '*', '~', '#', '&', '%', '@'];
  const iconChar = anonIcons[Math.abs(hashCode(drop.dropId)) % anonIcons.length];

  const voted = state.deadDropVoted[drop.dropId];
  const zone = drop.zone || 'signals';
  const zoneBadge = `<span class="deaddrop-zone-badge">#${escapeHtml(zone)}</span>`;
  const flareBadge = drop.isFlare ? '<span class="deaddrop-flare-badge">&#128293; FLARE</span>' : '';

  card.innerHTML = `
    <div class="deaddrop-header">
      <div class="deaddrop-anon-icon">${iconChar}</div>
      <span>Anonymous</span>
      ${zoneBadge}${flareBadge}
      <span class="deaddrop-time">${time}</span>
    </div>
    <div class="deaddrop-content">${renderContentWithGifs(content)}</div>
    <div class="deaddrop-actions">
      <button class="deaddrop-vote-btn ${voted === 'up' ? 'voted' : ''}" onclick="voteDeadDrop('${escapeAttr(drop.dropId)}', 'up')">&#9650;</button>
      <span class="deaddrop-score">${drop.votes || 0}</span>
      <button class="deaddrop-vote-btn ${voted === 'down' ? 'voted' : ''}" onclick="voteDeadDrop('${escapeAttr(drop.dropId)}', 'down')">&#9660;</button>
      ${!isReply ? `<button class="deaddrop-reply-btn" onclick="replyToDrop('${escapeAttr(drop.dropId)}')" title="Reply anonymously">&#8617; Reply</button>` : ''}
      <span class="deaddrop-expiry">${expiryText}</span>
    </div>
  `;

  return card;
}

let activeDropZone = 'all';
let replyingToDropId = null;

function setDropZone(zone) {
  activeDropZone = zone;
  document.querySelectorAll('.zone-btn').forEach(b => b.classList.toggle('active', b.dataset.zone === zone));
  renderDeadDrops();
}

function replyToDrop(dropId) {
  replyingToDropId = dropId;
  const input = document.getElementById('deaddrop-input');
  input.placeholder = 'Reply anonymously...';
  input.focus();
  showToast('Replying', 'Your reply will be anonymous and linked to this drop');
}

function cancelReply() {
  replyingToDropId = null;
  document.getElementById('deaddrop-input').placeholder = 'Drop something into the void...';
}

async function submitDeadDrop() {
  const input = document.getElementById('deaddrop-input');
  const text = input.value.trim();
  if (!text) return;
  if (text.length > 1000) {
    showToast('Drop too long', 'Max 1000 characters');
    return;
  }

  const zone = document.getElementById('deaddrop-zone-select').value;
  const isFlare = document.getElementById('deaddrop-flare').checked;

  const btn = document.getElementById('btn-dead-drop');
  const powStatus = document.getElementById('deaddrop-pow-status');
  btn.disabled = true;
  powStatus.classList.remove('hidden');
  if (isFlare) powStatus.textContent = 'Computing high-intensity proof-of-work (flare)...';

  try {
    const result = await send('create_dead_drop', {
      content: text,
      zone,
      parentDropId: replyingToDropId || undefined,
      isFlare,
    });
    input.value = '';
    document.getElementById('deaddrop-char-counter').textContent = '0/1000';
    if (result && result.warning) {
      showToast('Anonymity Warning', result.warning);
    } else {
      showToast('Drop submitted', 'Your anonymous message is being routed...');
    }
  } catch (e) {
    showToast('Drop failed', e.message || 'Unknown error');
  } finally {
    btn.disabled = false;
    powStatus.classList.add('hidden');
    powStatus.textContent = 'Computing proof-of-work...';
    cancelReply();
    document.getElementById('deaddrop-flare').checked = false;
  }
}

async function voteDeadDrop(dropId, direction) {
  if (state.deadDropVoted[dropId]) {
    showToast('Already voted', 'You can only vote once per drop');
    return;
  }
  try {
    const result = await send('vote_dead_drop', { dropId, direction });
    state.deadDropVoted[dropId] = direction;
    // Update local state
    const drop = state.deadDrops.find(d => d.dropId === dropId);
    if (drop) drop.votes = result.votes;
    // Re-render card
    const card = document.getElementById(`deaddrop-${dropId}`);
    if (card && drop) {
      card.replaceWith(renderDeadDropCard(drop));
    }
  } catch (e) {
    showToast('Vote failed', e.message || 'Unknown error');
  }
}

function onNewDeadDrop(data) {
  const { drop, content } = data;
  // Dedup
  if (state.deadDrops.find(d => d.dropId === drop.dropId)) return;
  state.deadDrops.unshift(drop);
  if (content) state.deadDropContents[drop.dropId] = content;
  if (state.activeView === 'deaddrops') {
    const feed = document.getElementById('deaddrop-feed');
    const hint = feed.querySelector('.sidebar-hint');
    if (hint) hint.remove();
    feed.prepend(renderDeadDropCard(drop));
  }
}

// ─── Encrypted Polls ──────────────────────────────────────────────────────────

function renderPollCard(poll) {
  const isCreator = poll.isCreator || poll.creatorId === state.myPeerId;
  const hasVoted = poll.hasVoted || state.pollReceipts[poll.pollId] !== undefined;
  const votedIdx = poll.votedOptionIndex ?? state.pollReceipts[poll.pollId] ?? null;
  const results = poll.results || state.pollResultsData[poll.pollId];
  const isTallied = poll.status === 'tallied' && results;
  const isExpired = poll.expiresAt < Date.now();
  const isOpen = poll.status === 'open' && !isExpired;

  const creatorName = escapeHtml(poll.creatorName || poll.creatorId.slice(0, 12));
  const safePollId = escapeAttr(poll.pollId);
  const safeCreatorId = escapeAttr(poll.creatorId);
  const time = relativeTime(poll.createdAt);

  let timeLabel = '';
  if (isTallied) {
    timeLabel = 'Final results';
  } else if (isExpired) {
    timeLabel = 'Expired';
  } else {
    const remaining = poll.expiresAt - Date.now();
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    timeLabel = h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }

  let optionsHTML = '';
  if (isTallied) {
    const total = results.tally.reduce((a, b) => a + b, 0);
    optionsHTML = poll.options.map((opt, i) => {
      const count = results.tally[i] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const isMyVote = votedIdx === i;
      return `<div class="poll-result-bar${isMyVote ? ' my-vote' : ''}">
        <div class="poll-result-fill" style="width:${pct}%"></div>
        <span class="poll-result-label">${escapeHtml(opt)}</span>
        <span class="poll-result-pct">${pct}% (${count})</span>
      </div>`;
    }).join('');
    optionsHTML += `<div class="poll-total">${total} vote${total !== 1 ? 's' : ''}</div>`;
  } else if (hasVoted) {
    optionsHTML = poll.options.map((opt, i) => {
      const isSelected = votedIdx === i;
      return `<div class="poll-option-btn${isSelected ? ' selected' : ''}">${escapeHtml(opt)}${isSelected ? ' &#10003;' : ''}</div>`;
    }).join('');
    optionsHTML += `<div class="poll-voted-msg subtle">Your vote is encrypted. Awaiting tally.</div>`;
  } else if (isOpen) {
    optionsHTML = poll.options.map((opt, i) => {
      return `<div class="poll-option-btn clickable" onclick="castPollVote('${safePollId}', ${i})">${escapeHtml(opt)}</div>`;
    }).join('');
  } else {
    optionsHTML = poll.options.map(opt => {
      return `<div class="poll-option-btn">${escapeHtml(opt)}</div>`;
    }).join('');
    optionsHTML += `<div class="poll-voted-msg subtle">Poll closed. Awaiting tally.</div>`;
  }

  let actionsHTML = '';
  if (isCreator && (isExpired || poll.status === 'closed') && !isTallied) {
    actionsHTML += `<button class="poll-tally-btn btn-primary" onclick="tallyPoll('${safePollId}')">Tally &amp; Publish Results</button>`;
  }
  if (isTallied && hasVoted) {
    actionsHTML += `<button class="btn-secondary" onclick="openPollResults('${safePollId}')">Verify</button>`;
  }
  if (isTallied) {
    actionsHTML += `<button class="btn-secondary" onclick="openPollResults('${safePollId}')">Details</button>`;
  }

  return `<div class="poll-card" id="poll-${safePollId}">
    <div class="post-header">
      <canvas class="post-avatar" width="32" height="32" data-peerid="${safeCreatorId}"></canvas>
      <div class="post-author-info">
        <span class="post-author clickable-name" onclick="openProfile('${safeCreatorId}')">${creatorName}</span>
        <span class="poll-badge">Poll</span>
        <span class="post-time">${time}</span>
      </div>
      <span class="poll-time-label subtle">${timeLabel}</span>
    </div>
    <div class="poll-question">${escapeHtml(poll.question)}</div>
    <div class="poll-options">${optionsHTML}</div>
    ${actionsHTML ? `<div class="poll-actions">${actionsHTML}</div>` : ''}
    ${isCreator && isOpen ? `<div class="poll-total subtle">${poll.voteCount || 0} vote${(poll.voteCount || 0) !== 1 ? 's' : ''} received</div>` : ''}
  </div>`;
}

async function castPollVote(pollId, optionIndex) {
  try {
    await send('cast_vote', { pollId, optionIndex });
    state.pollReceipts[pollId] = optionIndex;
    // Update the poll in state
    const poll = state.polls.find(p => p.pollId === pollId);
    if (poll) {
      poll.hasVoted = true;
      poll.votedOptionIndex = optionIndex;
    }
    renderFeed();
    showToast('Vote cast! Your vote is encrypted.');
  } catch (e) {
    showToast('Failed to vote: ' + (e.message || e));
  }
}

async function tallyPoll(pollId) {
  try {
    const res = await send('tally_poll', { pollId });
    state.pollResultsData[pollId] = res.results;
    const poll = state.polls.find(p => p.pollId === pollId);
    if (poll) {
      poll.status = 'tallied';
      poll.results = res.results;
    }
    renderFeed();
    showToast('Results published!');
  } catch (e) {
    showToast('Failed to tally: ' + (e.message || e));
  }
}

function openPollResults(pollId) {
  state.currentPollId = pollId;
  const poll = state.polls.find(p => p.pollId === pollId);
  const results = state.pollResultsData[pollId] || (poll && poll.results);
  if (!poll || !results) {
    showToast('Results not available');
    return;
  }

  document.getElementById('poll-results-title').textContent = poll.question;
  const total = results.tally.reduce((a, b) => a + b, 0);
  const votedIdx = state.pollReceipts[pollId] ?? null;

  let html = '';
  poll.options.forEach((opt, i) => {
    const count = results.tally[i] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const isMyVote = votedIdx === i;
    html += `<div class="poll-result-detail${isMyVote ? ' my-vote' : ''}">
      <span>${escapeHtml(opt)}${isMyVote ? ' (your vote)' : ''}</span>
      <span>${pct}% (${count})</span>
    </div>`;
  });
  html += `<div class="poll-total">${total} total vote${total !== 1 ? 's' : ''}</div>`;
  html += `<div class="subtle" style="margin-top:8px">Proof hashes: ${results.proofHashes.length} | Published: ${new Date(results.publishedAt).toLocaleString()}</div>`;

  document.getElementById('poll-results-body').innerHTML = html;

  // Show verify section if we voted
  const verifySection = document.getElementById('poll-verify-section');
  const verifyResult = document.getElementById('poll-verify-result');
  if (votedIdx !== null && votedIdx !== undefined) {
    verifySection.classList.remove('hidden');
    verifyResult.classList.add('hidden');
  } else {
    verifySection.classList.add('hidden');
  }

  document.getElementById('poll-results-modal').classList.remove('hidden');
}

function closePollResultsModal() {
  document.getElementById('poll-results-modal').classList.add('hidden');
  state.currentPollId = null;
}

async function verifyPollVote() {
  const pollId = state.currentPollId;
  if (!pollId) return;
  try {
    const res = await send('verify_poll_vote', { pollId });
    const el = document.getElementById('poll-verify-result');
    el.classList.remove('hidden');
    if (res.verified) {
      el.style.color = 'var(--green)';
      el.textContent = res.message;
    } else {
      el.style.color = 'var(--red)';
      el.textContent = res.message;
    }
  } catch (e) {
    showToast('Verification failed: ' + (e.message || e));
  }
}

function showCreatePollModal(groupId) {
  // Reset inputs
  document.getElementById('poll-question-input').value = '';
  const optionsList = document.getElementById('poll-options-list');
  optionsList.innerHTML = `
    <input type="text" class="poll-option-input" placeholder="Option 1" maxlength="200">
    <input type="text" class="poll-option-input" placeholder="Option 2" maxlength="200">
  `;
  document.getElementById('poll-duration-select').value = '86400000';

  // Populate scope
  const scopeSelect = document.getElementById('poll-scope-select');
  scopeSelect.innerHTML = '<option value="public">Public (Feed)</option>';
  if (groupId) {
    scopeSelect.innerHTML += `<option value="group" selected>Group</option>`;
    scopeSelect.dataset.groupId = groupId;
  } else {
    scopeSelect.dataset.groupId = '';
  }

  document.getElementById('poll-modal').classList.remove('hidden');
}

function closePollModal() {
  document.getElementById('poll-modal').classList.add('hidden');
}

function addPollOption() {
  const list = document.getElementById('poll-options-list');
  const count = list.querySelectorAll('.poll-option-input').length;
  if (count >= 10) { showToast('Maximum 10 options'); return; }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'poll-option-input';
  input.placeholder = `Option ${count + 1}`;
  input.maxLength = 200;
  list.appendChild(input);
}

async function submitCreatePoll() {
  const question = document.getElementById('poll-question-input').value.trim();
  const optInputs = document.querySelectorAll('#poll-options-list .poll-option-input');
  const options = Array.from(optInputs).map(i => i.value.trim()).filter(Boolean);
  const durationMs = parseInt(document.getElementById('poll-duration-select').value);
  const scopeSelect = document.getElementById('poll-scope-select');
  const scope = scopeSelect.value;
  const groupId = scopeSelect.dataset.groupId || undefined;

  if (!question) { showToast('Question is required'); return; }
  if (options.length < 2) { showToast('At least 2 options required'); return; }

  try {
    const res = await send('create_poll', { question, options, durationMs, scope, groupId });
    closePollModal();
    // Add to local state
    const poll = res.poll;
    poll.isCreator = true;
    poll.hasVoted = false;
    poll.votedOptionIndex = null;
    poll.results = null;
    state.polls.unshift(poll);
    renderFeed();
    showToast('Poll created!');
  } catch (e) {
    showToast('Failed to create poll: ' + (e.message || e));
  }
}

function onNewPoll(poll) {
  // Dedup
  if (state.polls.some(p => p.pollId === poll.pollId)) return;
  poll.hasVoted = false;
  poll.votedOptionIndex = null;
  poll.results = null;
  poll.isCreator = poll.creatorId === state.myPeerId;
  state.polls.unshift(poll);
  if (state.activeView === 'feed') renderFeed();
  showToast(`${poll.creatorName || 'Someone'} created a poll`, poll.question.slice(0, 40));
}

function onPollResultsEvent(data) {
  const { poll, results } = data;
  state.pollResultsData[poll.pollId] = results;
  const existing = state.polls.find(p => p.pollId === poll.pollId);
  if (existing) {
    existing.status = 'tallied';
    existing.results = results;
  }
  if (state.activeView === 'feed') renderFeed();
  showToast('Poll results published!', poll.question.slice(0, 40));
}

function onPollVoteReceived(data) {
  const existing = state.polls.find(p => p.pollId === data.pollId);
  if (existing) {
    existing.voteCount = (existing.voteCount || 0) + 1;
    // Re-render just the vote count if visible
    const card = document.getElementById('poll-' + data.pollId);
    if (card) {
      const totalEl = card.querySelector('.poll-total.subtle');
      if (totalEl) totalEl.textContent = `${existing.voteCount} vote${existing.voteCount !== 1 ? 's' : ''} received`;
    }
  }
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// Wire character counter for dead drop input
document.addEventListener('DOMContentLoaded', () => {
  const ddInput = document.getElementById('deaddrop-input');
  if (ddInput) {
    ddInput.addEventListener('input', () => {
      const len = ddInput.value.length;
      document.getElementById('deaddrop-char-counter').textContent = `${len}/1000`;
    });
  }
});

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Escape a string for safe use inside HTML attribute values (single-quoted) */
function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Validate that a string is a safe data URL for media (image/video/audio base64) or blob URL */
function isSafeMediaSrc(src) {
  if (!src) return false;
  if (src.startsWith('blob:')) return true;
  if (/^data:(image|video|audio)\/[a-zA-Z0-9+.\-]+;base64,[A-Za-z0-9+/=\s]+$/.test(src)) return true;
  if (src.startsWith('https://')) return true;
  return false;
}

/** Validate CSS color value (hex, rgb, hsl only) */
function isSafeColor(val) {
  if (!val) return false;
  return /^#[0-9a-fA-F]{3,8}$/.test(val) || /^(rgb|hsl)a?\([0-9, .%]+\)$/.test(val);
}

/** Whitelist check for font style values */
function isSafeFontStyle(val) {
  return ['sans', 'serif', 'mono', 'handwritten'].includes(val);
}

// ─── Hubs ────────────────────────────────────────────────────────────────────

const refreshHubs = debounce(async () => {
  try {
    state.hubs = await send('get_hubs');
    renderHubStrip();
  } catch (e) { console.error('Failed to refresh hubs:', e); }
}, 300);

// ─── Hub Notifications ─────────────────────────────────────────────────────

const hubNotifications = [];
const MAX_HUB_NOTIFICATIONS = 20;

function addHubNotification(title, desc, hubId) {
  hubNotifications.unshift({
    title,
    desc,
    hubId,
    timestamp: Date.now(),
  });
  if (hubNotifications.length > MAX_HUB_NOTIFICATIONS) hubNotifications.pop();
  updateHubNotifBadge();
}

function updateHubNotifBadge() {
  const btn = document.getElementById('hub-notif-btn');
  const badge = document.getElementById('hub-notif-badge');
  if (hubNotifications.length > 0) {
    btn.classList.remove('hidden');
    badge.classList.remove('hidden');
    badge.textContent = hubNotifications.length;
  } else {
    badge.classList.add('hidden');
  }
}

function showHubNotifications() {
  const panel = document.getElementById('hub-notif-panel');
  panel.classList.toggle('hidden');

  const list = document.getElementById('hub-notif-list');
  if (hubNotifications.length === 0) {
    list.innerHTML = '<div class="hub-notif-empty">No notifications</div>';
    return;
  }

  list.innerHTML = hubNotifications.map(n => `
    <div class="hub-notif-item" onclick="handleHubNotifClick('${escapeAttr(n.hubId || '')}')">
      <div class="hub-notif-title">${escapeHtml(n.title)}</div>
      <div class="hub-notif-desc">${escapeHtml(n.desc)}</div>
      <div class="hub-notif-time">${relativeTime(n.timestamp)}</div>
    </div>
  `).join('');
}

function handleHubNotifClick(hubId) {
  document.getElementById('hub-notif-panel').classList.add('hidden');
  if (hubId) selectHub(hubId);
}

function clearHubNotifications() {
  hubNotifications.length = 0;
  updateHubNotifBadge();
  document.getElementById('hub-notif-list').innerHTML = '<div class="hub-notif-empty">No notifications</div>';
  document.getElementById('hub-notif-panel').classList.add('hidden');
}

function renderHubStrip() {
  const strip = document.getElementById('hub-strip');
  const list = document.getElementById('hub-icons-list');
  // Always show the hub strip so users can create their first hub
  strip.classList.remove('hidden');
  list.innerHTML = state.hubs.map(h => {
    const active = state.activeHub && state.activeHub.hubId === h.hubId ? ' active' : '';
    const iconContent = renderHubIcon(h.icon, h.name, 'hub-icon-img');
    const inVoice = state.voiceChannel && state.voiceChannel.hubId === h.hubId ? ' in-voice' : '';
    return `<button class="hub-icon${active}${inVoice}" data-hubid="${escapeAttr(h.hubId)}" onclick="selectHub('${escapeAttr(h.hubId)}')" title="${escapeAttr(h.name)}">${iconContent}</button>`;
  }).join('');
}

async function selectHub(hubId) {
  if (state._selectingHub) return; // Prevent concurrent calls
  state._selectingHub = true;
  // Don't leave voice when switching hubs — voice persists
  // Only leave if joining a different voice channel (handled in openChannel)
  try {
    const data = await send('get_hub', { hubId });
    state.activeHub = data.hub;
    state.hubCategories = data.categories || [];
    state.hubChannels = data.channels || [];
    state.hubMembers = data.members || [];
    state.activeChannel = null;
    state.activeChat = null;

    // Switch sidebar to hub mode
    document.getElementById('sidebar-tabs').classList.add('hidden');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('hub-sidebar').classList.remove('hidden');
    const sidebarNameEl = document.getElementById('hub-sidebar-name');
    if (isUrlIcon(data.hub.icon)) {
      sidebarNameEl.innerHTML = `<img src="${escapeAttr(data.hub.icon)}" alt="" class="hub-sidebar-icon-img"> ${escapeHtml(data.hub.name)}`;
    } else {
      sidebarNameEl.textContent = data.hub.name;
    }

    // Show/hide settings based on role
    const settingsBtn = document.getElementById('hub-settings-btn');
    settingsBtn.style.display = data.myRole === 'owner' || data.myRole === 'admin' ? '' : 'none';

    renderHubChannels();
    renderHubStrip();

    // Show member panel
    state.memberPanelOpen = true;
    document.getElementById('member-panel').classList.remove('hidden');
    renderHubMemberPanel();

    // Show hub overview as default landing
    showHubOverview(hubId);

    // Make hub name clickable to return to overview
    const sidebarNameClick = document.getElementById('hub-sidebar-name');
    if (sidebarNameClick) sidebarNameClick.style.cursor = 'pointer';
    if (sidebarNameClick) sidebarNameClick.onclick = () => showHubOverview(hubId);

    // Mark DM button as inactive
    document.getElementById('hub-dm-btn').classList.remove('active');
  } catch (e) { showToast('Failed to load hub', e.message); }
  finally { state._selectingHub = false; }
}

function selectDMMode() {
  // Don't leave voice — voice persists across navigation
  state.activeHub = null;
  state.activeChannel = null;
  state.hubCategories = [];
  state.hubChannels = [];
  state.hubMembers = [];

  // Switch sidebar back to DM mode
  document.getElementById('hub-sidebar').classList.add('hidden');
  document.getElementById('sidebar-tabs').classList.remove('hidden');
  switchTab('feed');

  // Hide member panel
  state.memberPanelOpen = false;
  document.getElementById('member-panel').classList.add('hidden');

  renderHubStrip();
  document.getElementById('hub-dm-btn').classList.add('active');
}

function renderHubChannels() {
  const el = document.getElementById('hub-channels-list');
  if (!state.activeHub) { el.innerHTML = ''; return; }

  // Group channels by category
  const cats = state.hubCategories.sort((a, b) => a.position - b.position);
  let html = '';
  for (const cat of cats) {
    const channels = state.hubChannels
      .filter(c => c.categoryId === cat.categoryId)
      .sort((a, b) => a.position - b.position);
    html += `<div class="hub-category">
      <div class="category-header" onclick="toggleCategory(this)">${escapeAttr(cat.name)}</div>
      <div class="category-channels">`;
    for (const ch of channels) {
      const active = state.activeChannel && state.activeChannel.channelId === ch.channelId ? ' active' : '';
      const prefix = ch.type === 'text' ? '#' : '&#128266;';
      html += `<div class="channel-item${active}" onclick="openChannel('${escapeAttr(state.activeHub.hubId)}','${escapeAttr(ch.channelId)}','${escapeAttr(ch.name)}')">${prefix} ${escapeAttr(ch.name)}</div>`;

      // Show voice channel occupancy
      if (ch.type === 'voice') {
        const vcKey = `${state.activeHub.hubId}:${ch.channelId}`;
        const inThisChannel = state.voiceChannel && state.voiceChannel.channelId === ch.channelId;
        const occupants = (state.voiceOccupancy && state.voiceOccupancy[vcKey]) || {};
        const hasOccupants = inThisChannel || Object.keys(occupants).length > 0;

        if (hasOccupants) {
          html += '<div class="voice-users-inline">';
          // Self (if joined)
          if (inThisChannel) {
            html += `<div class="voice-user-inline">
              <canvas class="voice-user-avatar" width="20" height="20" data-peerid="${escapeAttr(state.myPeerId)}"></canvas>
              <span>${escapeHtml(state.myName || 'You')}</span>
              ${state.voiceMuted ? '<span class="voice-muted-icon">&#128263;</span>' : ''}
            </div>`;
          }
          // Other peers (from occupancy tracking or voicePeers)
          const shownPeers = new Set();
          for (const [peerId, peer] of Object.entries(state.voicePeers || {})) {
            if (inThisChannel) {
              shownPeers.add(peerId);
              html += `<div class="voice-user-inline">
                <canvas class="voice-user-avatar" width="20" height="20" data-peerid="${escapeAttr(peerId)}"></canvas>
                <span>${escapeHtml(peer.name || peerId.slice(0, 12))}</span>
              </div>`;
            }
          }
          // Show occupants we haven't connected to yet
          for (const [peerId, info] of Object.entries(occupants)) {
            if (peerId === state.myPeerId || shownPeers.has(peerId)) continue;
            html += `<div class="voice-user-inline">
              <canvas class="voice-user-avatar" width="20" height="20" data-peerid="${escapeAttr(peerId)}"></canvas>
              <span>${escapeHtml(info.name || peerId.slice(0, 12))}</span>
            </div>`;
          }
          html += '</div>';
        }
      }
    }
    html += '</div></div>';
  }
  el.innerHTML = html;

  // Draw inline voice avatars
  requestAnimationFrame(() => {
    el.querySelectorAll('canvas.voice-user-avatar').forEach(c => {
      const pid = c.dataset.peerid;
      if (pid) drawAvatar(c, pid);
    });
  });
}

function toggleCategory(el) {
  el.parentElement.classList.toggle('collapsed');
}

async function openChannel(hubId, channelId, name) {
  const channelObj = state.hubChannels.find(c => c.channelId === channelId);

  // Voice channel: join voice mesh, but also open text chat for it
  if (channelObj && channelObj.type === 'voice') {
    joinVoiceChannel(hubId, channelId, name);
    // Don't return — fall through to open text chat too
  } else {
    // Switching to a text channel does NOT leave voice — voice persists across channel switches
  }

  state.activeChannel = { hubId, channelId, name };
  state.activeChat = null;

  showView('chat');
  const prefix = channelObj && channelObj.type === 'voice' ? '🔊' : '#';
  document.getElementById('chat-peer-name').textContent = `${prefix} ${name}`;
  document.getElementById('chat-peer-name').onclick = null;
  document.getElementById('chat-peer-status').textContent = '';
  document.getElementById('chat-actions').style.display = 'none';

  // Update channel highlight
  renderHubChannels();

  try {
    const messages = await send('get_hub_history', { hubId, channelId, limit: 100 });
    state.messages = messages;
    renderMessages(messages);
  } catch (e) { console.error('Failed to load channel history:', e); }
}

function renderHubMemberPanel() {
  const el = document.getElementById('member-panel-list');
  if (!state.hubMembers.length) { el.innerHTML = '<div class="empty-state-rich"><div class="empty-state-icon">&#128101;</div><div class="empty-state-text"><strong>No members yet</strong>Invite friends to join!</div></div>'; return; }

  const roleOrder = { owner: 0, admin: 1, member: 2 };
  const sorted = [...state.hubMembers].sort((a, b) => (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9));

  let html = '';
  let lastRole = '';
  for (const m of sorted) {
    if (m.role !== lastRole) {
      const label = m.role === 'owner' ? 'OWNER' : m.role === 'admin' ? 'ADMINS' : 'MEMBERS';
      html += `<div class="member-role-header">${label}</div>`;
      lastRole = m.role;
    }
    const onlineDot = m.isOnline ? '<span class="online-dot"></span>' : '';
    const isSelf = m.peerId === state.myPeerId;
    html += `<div class="member-item" ${!isSelf ? `onclick="openPeerProfile('${escapeAttr(m.peerId)}')"` : ''}>
      <span class="member-name">${onlineDot}${escapeAttr(m.displayName || m.peerId.slice(0, 12))}</span>
      <span class="role-badge role-${m.role}">${m.role}</span>
    </div>`;
  }
  el.innerHTML = html;
}

async function refreshHubMembers(hubId) {
  try {
    state.hubMembers = await send('get_hub_members', { hubId });
    renderHubMemberPanel();
  } catch {}
}

function toggleMemberPanel() {
  state.memberPanelOpen = !state.memberPanelOpen;
  document.getElementById('member-panel').classList.toggle('hidden', !state.memberPanelOpen);
}

function onHubMessage(data) {
  if (state.activeChannel && state.activeChannel.hubId === data.hubId && state.activeChannel.channelId === data.channelId) {
    appendMessage({ from: data.from, fromName: data.fromName, body: data.body, timestamp: data.timestamp, status: 'delivered' });
  } else {
    showToast(`[Hub] ${data.fromName}: ${data.body.slice(0, 40)}`);
  }
}

function onHubUpdated(data) {
  if (data.type === 'deleted' || data.type === 'kicked') {
    if (state.activeHub && state.activeHub.hubId === data.hubId) {
      selectDMMode();
      showToast(data.type === 'kicked' ? 'You were removed from the hub' : 'Hub was deleted');
    }
    refreshHubs();
    return;
  }
  // Only refresh hub strip (lightweight). Don't call selectHub() here —
  // the originating action (saveHubSettings, createChannel, etc.) already does that.
  // Calling selectHub from both places causes 4x DOM renders and UI freezes.
  refreshHubs();
}

// ─── Hub Creation ────────────────────────────────────────────────────────

function showCreateHubModal() {
  document.getElementById('hub-name-input').value = '';
  document.getElementById('hub-desc-input').value = '';
  document.getElementById('hub-icon-input').value = '';
  document.getElementById('hub-tags-input').value = '';
  document.getElementById('hub-public-toggle').checked = false;
  updateHubIconPreview('hub-icon-preview', '');
  document.getElementById('create-hub-modal').classList.remove('hidden');
}

function closeCreateHubModal() {
  document.getElementById('create-hub-modal').classList.add('hidden');
}

async function submitCreateHub() {
  const name = document.getElementById('hub-name-input').value.trim();
  if (!name) { showToast('Hub name is required'); return; }
  const description = document.getElementById('hub-desc-input').value.trim();
  const icon = document.getElementById('hub-icon-input').value.trim();
  const tagsStr = document.getElementById('hub-tags-input').value.trim();
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  const isPublic = document.getElementById('hub-public-toggle').checked;

  try {
    const result = await send('create_hub', { name, description, icon, tags, isPublic });
    closeCreateHubModal();
    await refreshHubs();
    selectHub(result.hubId);
    showToast(`Hub "${name}" created!`);
  } catch (e) { showToast('Failed to create hub', e.message); }
}

// ─── Hub Settings ────────────────────────────────────────────────────────

function showHubSettingsModal() {
  if (!state.activeHub) return;
  const hub = state.activeHub;
  document.getElementById('hub-settings-title').textContent = `${hub.name} — Settings`;
  document.getElementById('hs-name').value = hub.name;
  document.getElementById('hs-desc').value = hub.description || '';
  document.getElementById('hs-icon').value = hub.icon || '';
  updateHubIconPreview('hs-icon-preview', hub.icon || '');
  document.getElementById('hs-public').checked = hub.isPublic;

  // Show delete/leave based on role
  const myRole = state.hubs.find(h => h.hubId === hub.hubId)?.myRole;
  document.getElementById('hs-delete-btn').style.display = myRole === 'owner' ? '' : 'none';
  document.getElementById('hs-leave-btn').style.display = myRole !== 'owner' ? '' : 'none';
  document.getElementById('hs-save-btn').style.display = myRole === 'owner' ? '' : 'none';

  switchHubSettingsTab('overview');
  loadHubSettingsChannels();
  loadHubSettingsMembers();
  loadHubSettingsInvites();
  document.getElementById('hub-settings-modal').classList.remove('hidden');
}

function closeHubSettingsModal() {
  document.getElementById('hub-settings-modal').classList.add('hidden');
}

function switchHubSettingsTab(tab) {
  document.querySelectorAll('.hub-settings-tab').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.hub-settings-tab-bar .tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`htab-${tab}`).classList.remove('hidden');
  document.querySelector(`.hub-settings-tab-bar .tab[data-htab="${tab}"]`).classList.add('active');
}

async function saveHubSettings() {
  if (!state.activeHub) return;
  try {
    await send('update_hub', {
      hubId: state.activeHub.hubId,
      name: document.getElementById('hs-name').value.trim(),
      description: document.getElementById('hs-desc').value.trim(),
      icon: document.getElementById('hs-icon').value.trim(),
      isPublic: document.getElementById('hs-public').checked,
    });
    closeHubSettingsModal();
    await refreshHubs();
    selectHub(state.activeHub.hubId);
    showToast('Hub settings saved');
  } catch (e) { showToast('Failed to save', e.message); }
}

async function deleteCurrentHub() {
  if (!state.activeHub) return;
  if (!await showConfirm(`Delete hub "${state.activeHub.name}"? This cannot be undone.`)) return;
  try {
    await send('delete_hub', { hubId: state.activeHub.hubId });
    closeHubSettingsModal();
    selectDMMode();
    refreshHubs();
    showToast('Hub deleted');
  } catch (e) { showToast('Failed to delete', e.message); }
}

async function leaveCurrentHub() {
  if (!state.activeHub) return;
  if (!await showConfirm(`Leave hub "${state.activeHub.name}"?`)) return;
  try {
    await send('leave_hub', { hubId: state.activeHub.hubId });
    closeHubSettingsModal();
    selectDMMode();
    refreshHubs();
    showToast('Left hub');
  } catch (e) { showToast('Failed to leave', e.message); }
}

// ─── Hub Settings: Channels Tab ──────────────────────────────────────────

function loadHubSettingsChannels() {
  if (!state.activeHub) return;
  const el = document.getElementById('hs-categories-list');
  const cats = state.hubCategories.sort((a, b) => a.position - b.position);
  let html = '';
  for (const cat of cats) {
    const channels = state.hubChannels.filter(c => c.categoryId === cat.categoryId).sort((a, b) => a.position - b.position);
    html += `<div class="hs-category">
      <div class="hs-cat-header">
        <strong>${escapeAttr(cat.name)}</strong>
        <button class="icon-btn-sm" onclick="deleteHubCategory('${escapeAttr(cat.categoryId)}')" title="Delete category">&#10005;</button>
      </div>`;
    for (const ch of channels) {
      html += `<div class="hs-channel-item">
        <span>${ch.type === 'text' ? '#' : '&#128266;'} ${escapeAttr(ch.name)}</span>
        <button class="icon-btn-sm" onclick="deleteHubChannel('${escapeAttr(ch.channelId)}')" title="Delete">&#10005;</button>
      </div>`;
    }
    html += `<div class="hs-add-channel">
      <input type="text" class="hs-new-ch-name" placeholder="New channel" maxlength="50">
      <select class="hs-new-ch-type"><option value="text">Text</option><option value="voice">Voice</option></select>
      <button class="btn-secondary" onclick="createHubChannel('${escapeAttr(cat.categoryId)}', this)">+</button>
    </div></div>`;
  }
  el.innerHTML = html;
}

async function createHubCategory() {
  if (!state.activeHub) return;
  const name = document.getElementById('hs-new-cat-name').value.trim();
  if (!name) return;
  try {
    await send('create_category', { hubId: state.activeHub.hubId, name });
    document.getElementById('hs-new-cat-name').value = '';
    await selectHub(state.activeHub.hubId);
    loadHubSettingsChannels();
  } catch (e) { showToast('Failed to create category', e.message); }
}

async function createHubChannel(categoryId, btn) {
  if (!state.activeHub) return;
  const row = btn.parentElement;
  const name = row.querySelector('.hs-new-ch-name').value.trim();
  const type = row.querySelector('.hs-new-ch-type').value;
  if (!name) return;
  try {
    await send('create_channel', { hubId: state.activeHub.hubId, categoryId, name, type });
    row.querySelector('.hs-new-ch-name').value = '';
    await selectHub(state.activeHub.hubId);
    loadHubSettingsChannels();
  } catch (e) { showToast('Failed to create channel', e.message); }
}

async function deleteHubCategory(categoryId) {
  if (!state.activeHub || !await showConfirm('Delete this category and all its channels?')) return;
  try {
    await send('delete_category', { hubId: state.activeHub.hubId, categoryId });
    await selectHub(state.activeHub.hubId);
    loadHubSettingsChannels();
  } catch (e) { showToast('Failed to delete category', e.message); }
}

async function deleteHubChannel(channelId) {
  if (!state.activeHub || !await showConfirm('Delete this channel?')) return;
  try {
    await send('delete_channel', { hubId: state.activeHub.hubId, channelId });
    await selectHub(state.activeHub.hubId);
    loadHubSettingsChannels();
  } catch (e) { showToast('Failed to delete channel', e.message); }
}

// ─── Hub Settings: Members Tab ───────────────────────────────────────────

async function loadHubSettingsMembers() {
  if (!state.activeHub) return;
  // Populate invite dropdown with contacts
  const sel = document.getElementById('hs-invite-peer-select');
  const memberIds = new Set(state.hubMembers.map(m => m.peerId));
  sel.innerHTML = state.contacts
    .filter(c => !memberIds.has(c.peerId))
    .map(c => `<option value="${escapeAttr(c.peerId)}">${escapeAttr(c.displayName)}</option>`)
    .join('');

  const el = document.getElementById('hs-members-list');
  const myRole = state.hubs.find(h => h.hubId === state.activeHub.hubId)?.myRole;
  const roleOrder = { owner: 0, admin: 1, member: 2 };
  const sorted = [...state.hubMembers].sort((a, b) => (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9));

  let html = '';
  for (const m of sorted) {
    const isSelf = m.peerId === state.myPeerId;
    let actions = '';
    if (!isSelf && myRole === 'owner') {
      if (m.role === 'member') actions += `<button class="btn-secondary btn-sm" onclick="changeHubRole('${escapeAttr(m.peerId)}','admin')">Promote</button>`;
      if (m.role === 'admin') actions += `<button class="btn-secondary btn-sm" onclick="changeHubRole('${escapeAttr(m.peerId)}','member')">Demote</button>`;
      actions += `<button class="btn-danger btn-sm" onclick="kickHubMember('${escapeAttr(m.peerId)}')">Kick</button>`;
    } else if (!isSelf && myRole === 'admin' && m.role === 'member') {
      actions += `<button class="btn-danger btn-sm" onclick="kickHubMember('${escapeAttr(m.peerId)}')">Kick</button>`;
    }
    html += `<div class="hs-member-row">
      <span>${escapeAttr(m.displayName || m.peerId.slice(0, 12))} <span class="role-badge role-${m.role}">${m.role}</span></span>
      <span>${actions}</span>
    </div>`;
  }
  el.innerHTML = html;
}

async function inviteHubMember() {
  if (!state.activeHub) return;
  const peerId = document.getElementById('hs-invite-peer-select').value;
  if (!peerId) { showToast('Select a contact to invite'); return; }
  try {
    await send('invite_hub_member', { hubId: state.activeHub.hubId, peerId });
    showToast('Invite sent');
    await selectHub(state.activeHub.hubId);
    loadHubSettingsMembers();
  } catch (e) { showToast('Failed to invite', e.message); }
}

async function kickHubMember(peerId) {
  if (!state.activeHub || !await showConfirm('Kick this member?')) return;
  try {
    await send('kick_hub_member', { hubId: state.activeHub.hubId, peerId });
    showToast('Member kicked');
    await selectHub(state.activeHub.hubId);
    loadHubSettingsMembers();
  } catch (e) { showToast('Failed to kick', e.message); }
}

async function changeHubRole(peerId, role) {
  if (!state.activeHub) return;
  try {
    await send('change_hub_role', { hubId: state.activeHub.hubId, peerId, role });
    showToast(`Role changed to ${role}`);
    await selectHub(state.activeHub.hubId);
    loadHubSettingsMembers();
  } catch (e) { showToast('Failed to change role', e.message); }
}

// ─── Hub Settings: Invites Tab ───────────────────────────────────────────

async function loadHubSettingsInvites() {
  if (!state.activeHub) return;
  try {
    const invites = await send('get_hub_invites', { hubId: state.activeHub.hubId });
    const el = document.getElementById('hs-invites-list');
    if (!invites.length) { el.innerHTML = '<div class="subtle">No invites yet</div>'; return; }
    el.innerHTML = invites.map(inv => {
      const expires = inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : 'Never';
      const uses = inv.maxUses ? `${inv.uses}/${inv.maxUses}` : `${inv.uses} uses`;
      return `<div class="hs-invite-row"><span>${uses} &middot; Expires: ${expires}</span></div>`;
    }).join('');
  } catch {}
}

async function createHubInviteCode() {
  if (!state.activeHub) return;
  try {
    const result = await send('create_hub_invite', { hubId: state.activeHub.hubId });
    const display = document.getElementById('hs-invite-code-display');
    document.getElementById('hs-invite-code').value = result.code;
    display.classList.remove('hidden');
    loadHubSettingsInvites();
  } catch (e) { showToast('Failed to create invite', e.message); }
}

function copyHubInviteCode() {
  const code = document.getElementById('hs-invite-code').value;
  navigator.clipboard.writeText(code).then(() => showToast('Invite code copied!'));
}

// ─── Browse/Discover Hubs ────────────────────────────────────────────────

function showBrowseHubsModal() {
  document.getElementById('hub-search-input').value = '';
  document.getElementById('hub-invite-code-input').value = '';
  document.getElementById('hub-listings').innerHTML = '<div class="subtle">Loading...</div>';
  document.getElementById('browse-hubs-modal').classList.remove('hidden');
  // Reset to browse tab
  switchHubBrowseTab('browse');
  browseHubs();
}

function closeBrowseHubsModal() {
  document.getElementById('browse-hubs-modal').classList.add('hidden');
}

async function browseHubs() {
  try {
    const listings = await send('browse_hubs');
    state.hubListings = listings;
    renderHubListings();
  } catch (e) { showToast('Failed to browse hubs', e.message); }
}

async function searchHubs() {
  const term = document.getElementById('hub-search-input').value.trim();
  try {
    const listings = await send('discover_hubs', { searchTerm: term });
    state.hubListings = listings;
    renderHubListings();
  } catch (e) { showToast('Search failed', e.message); }
}

function renderHubListings() {
  const el = document.getElementById('hub-listings');
  if (!state.hubListings.length) { el.innerHTML = '<div class="subtle">No hubs found</div>'; return; }
  el.innerHTML = state.hubListings.map(h => {
    const iconContent = renderHubIcon(h.icon, h.name, 'hub-card-icon-img');
    const tags = (h.tags || []).map(t => `<span class="hub-tag">${escapeAttr(t)}</span>`).join('');
    const alreadyJoined = state.hubs.some(mh => mh.hubId === h.hubId);
    const btn = alreadyJoined
      ? '<button class="btn-secondary" disabled>Joined</button>'
      : `<button class="btn-primary hub-join-btn" onclick="joinDiscoveredHub('${escapeAttr(h.hubId)}')">Join</button>`;
    return `<div class="hub-card">
      <div class="hub-card-icon">${iconContent}</div>
      <div class="hub-card-info">
        <strong>${escapeAttr(h.name)}</strong>
        <span class="subtle">${escapeAttr(h.description || '')}</span>
        <span class="subtle">${h.memberCount} members</span>
        <div class="hub-tags">${tags}</div>
      </div>
      ${btn}
    </div>`;
  }).join('');
}

async function joinDiscoveredHub(hubId) {
  // For now, discovered hubs need an invite code to actually join
  showToast('Ask the hub owner for an invite code to join');
}

async function joinHubViaCode() {
  const code = document.getElementById('hub-invite-code-input').value.trim();
  if (!code) { showToast('Paste an invite code first'); return; }
  try {
    const result = await send('join_hub_invite', { code });
    closeBrowseHubsModal();
    await refreshHubs();
    if (result.hubId) selectHub(result.hubId);
    showToast(`Joined hub "${result.hubName || 'Hub'}"!`);
  } catch (e) { showToast('Failed to join hub', e.message); }
}

// ─── Hub Overview & Leaderboard ─────────────────────────────────────────────

async function showHubOverview(hubId) {
  showView('hub-overview');
  // Deselect any channel highlight
  document.querySelectorAll('.hub-channel-item').forEach(el => el.classList.remove('active'));

  const hub = state.activeHub;
  if (!hub) return;

  // Icon
  const iconEl = document.getElementById('hub-overview-icon');
  if (hub.icon && /^https?:\/\//.test(hub.icon)) {
    iconEl.innerHTML = `<img src="${escapeAttr(hub.icon)}" alt="">`;
  } else {
    iconEl.textContent = hub.icon || hub.name.charAt(0).toUpperCase();
  }

  document.getElementById('hub-overview-name').textContent = hub.name;
  document.getElementById('hub-overview-desc').textContent = hub.description || 'No description';

  // Fetch stats
  try {
    const stats = await send('get_hub_stats', { hubId });
    if (!stats) {
      document.getElementById('hub-overview-rank').innerHTML = '<span class="subtle">No stats yet</span>';
      return;
    }
    renderHubOverviewStats(stats);
  } catch (e) {
    document.getElementById('hub-overview-rank').innerHTML = '<span class="subtle">Stats unavailable</span>';
  }
}

function renderHubOverviewStats(stats) {
  // Rank badge
  const tierClass = 'tier-' + (stats.tier || 'Bronze').toLowerCase();
  const rankEl = document.getElementById('hub-overview-rank');
  rankEl.innerHTML = `
    <span class="tier-badge ${tierClass}">${stats.tier || 'Bronze'}</span>
    <span class="level-badge">Lv. ${stats.level || 1}</span>
    <span class="power-score-label">${(stats.powerScore || 0).toLocaleString()} Power</span>
  `;

  // XP bar (progress within current level)
  const levelProgress = ((stats.powerScore || 0) % 100);
  document.getElementById('hub-overview-xp-fill').style.width = levelProgress + '%';
  document.getElementById('hub-overview-xp-label').textContent =
    `${stats.powerScore || 0} / ${(stats.level || 1) * 100} XP to next level`;

  // Stat cards
  document.getElementById('stat-members').textContent = stats.totalMembers || 0;
  document.getElementById('stat-active').textContent = stats.activeMembersWeek || 0;
  document.getElementById('stat-mpd').textContent = stats.messagesPerDay || 0;
  document.getElementById('stat-voice').textContent = Math.round((stats.voiceMinutesTotal || 0) / 60);

  // Achievements
  const achList = document.getElementById('hub-achievements-list');
  if (stats.achievements && stats.achievements.length > 0) {
    achList.innerHTML = stats.achievements.map(id => {
      const meta = ACHIEVEMENT_META[id] || { label: id, icon: '\u2B50', desc: '' };
      return `<span class="achievement-badge" title="${escapeAttr(meta.desc)}"><span class="ach-icon">${meta.icon}</span> ${escapeHtml(meta.label)}</span>`;
    }).join('');
    document.getElementById('hub-overview-achievements').classList.remove('hidden');
  } else {
    achList.innerHTML = '<span class="subtle">No achievements yet</span>';
  }

  // Top contributors
  const contList = document.getElementById('hub-contributors-list');
  if (stats.topContributors && stats.topContributors.length > 0) {
    contList.innerHTML = stats.topContributors.map((c, i) => {
      const initial = (c.displayName || '?').charAt(0).toUpperCase();
      return `<div class="contributor-row">
        <span class="contributor-rank">#${i + 1}</span>
        <span class="contributor-avatar">${initial}</span>
        <span class="contributor-name">${escapeHtml(c.displayName || c.peerId.slice(0, 8))}</span>
        <span class="contributor-count">${c.messageCount} msgs</span>
      </div>`;
    }).join('');
    document.getElementById('hub-overview-contributors').classList.remove('hidden');
  } else {
    contList.innerHTML = '<span class="subtle">No contributors yet</span>';
  }

  // Sparkline
  if (stats.dailyMessageCounts && stats.dailyMessageCounts.length > 0) {
    drawHubSparkline(document.getElementById('hub-sparkline-canvas'), stats.dailyMessageCounts);
    document.getElementById('hub-overview-activity').classList.remove('hidden');
  }

  // Growth indicators from historical snapshots
  loadHubGrowthIndicators(stats);
}

async function loadHubGrowthIndicators(currentStats) {
  try {
    const weekAgo = Date.now() - 7 * 86400000;
    const history = await send('hub_stats_history', { hubId: currentStats.hubId, since: weekAgo });
    if (!history || history.length === 0) return;
    const oldest = history[0];
    const memberDiff = (currentStats.totalMembers || 0) - (oldest.totalMembers || 0);
    const msgToday = currentStats.messagesToday || 0;
    const growthEl = document.getElementById('stat-members');
    if (growthEl && memberDiff !== 0) {
      const sign = memberDiff > 0 ? '+' : '';
      growthEl.innerHTML = `${currentStats.totalMembers} <small style="color:var(--green);font-size:0.7em">${sign}${memberDiff} this week</small>`;
    }
    const msgEl = document.getElementById('stat-mpd');
    if (msgEl && msgToday > 0) {
      msgEl.innerHTML = `${currentStats.messagesPerDay} <small style="color:var(--text-muted);font-size:0.7em">${msgToday} today</small>`;
    }
  } catch {}
}

function drawHubSparkline(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const w = 400, h = 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(...data, 1);
  const barW = Math.floor((w - 20) / data.length) - 6;
  const startX = 10;
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date().getDay(); // 0=Sun
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c5ce7';

  for (let i = 0; i < data.length; i++) {
    const barH = (data[i] / max) * (h - 30);
    const x = startX + i * (barW + 6);
    const y = h - 20 - barH;

    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.4 + 0.6 * (data[i] / max);
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Value label
    if (data[i] > 0) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#fff';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(data[i].toString(), x + barW / 2, y - 4);
    }

    // Day label
    const dayIdx = (today - data.length + i + 8) % 7; // map to day of week
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#999';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(dayLabels[dayIdx] || '', x + barW / 2, h - 6);
  }
}

function switchHubBrowseTab(tab) {
  document.querySelectorAll('.hub-browse-tab').forEach(t => t.classList.remove('active'));
  if (tab === 'leaderboard') {
    document.querySelectorAll('.hub-browse-tab')[1].classList.add('active');
    document.getElementById('hub-browse-content').classList.add('hidden');
    document.getElementById('hub-leaderboard').classList.remove('hidden');
    loadHubLeaderboard();
  } else {
    document.querySelectorAll('.hub-browse-tab')[0].classList.add('active');
    document.getElementById('hub-browse-content').classList.remove('hidden');
    document.getElementById('hub-leaderboard').classList.add('hidden');
  }
}

async function loadHubLeaderboard() {
  const el = document.getElementById('hub-leaderboard');
  el.innerHTML = '<div class="subtle" style="padding:12px">Loading leaderboard...</div>';
  try {
    const entries = await send('get_hub_leaderboard', { limit: 30 });
    if (!entries || entries.length === 0) {
      el.innerHTML = '<div class="subtle" style="padding:12px">No hubs ranked yet. Create a hub and start chatting!</div>';
      return;
    }
    el.innerHTML = entries.map((e, i) => {
      const rank = i + 1;
      const rankClass = rank <= 3 ? ` leaderboard-rank-${rank}` : '';
      const tierClass = 'tier-' + (e.tier || 'Bronze').toLowerCase();
      let iconHtml;
      if (e.icon && /^https?:\/\//.test(e.icon)) {
        iconHtml = `<img src="${escapeAttr(e.icon)}" alt="">`;
      } else {
        iconHtml = e.icon || (e.name || '?').charAt(0).toUpperCase();
      }
      const joined = e.isJoined ? ' \u2713' : '';
      const trend = (e.dailyMessageCounts || []).slice(-7);
      const trendMax = Math.max(...trend, 1);
      const trendBars = trend.map(v => {
        const h = Math.max(2, Math.round((v / trendMax) * 22));
        return `<div class="leaderboard-trend-bar" style="height:${h}px"></div>`;
      }).join('');
      const achIcons = (e.achievements || []).slice(0, 3).map(a => (ACHIEVEMENT_META[a] || {}).icon || '').join('');
      return `<div class="leaderboard-row">
        <span class="leaderboard-rank${rankClass}">${rank}</span>
        <span class="leaderboard-icon">${iconHtml}</span>
        <div class="leaderboard-info">
          <div class="leaderboard-name">${escapeHtml(e.name || 'Unknown')}${joined}</div>
          <div class="leaderboard-meta">${e.memberCount || 0} members &middot; ${e.activeMembersWeek || 0} active &middot; ${(e.messagesPerDay || 0).toFixed(1)} msg/d ${achIcons}</div>
        </div>
        <div class="leaderboard-trend">${trendBars}</div>
        <div class="leaderboard-score">
          <div class="leaderboard-score-value">${(e.powerScore || 0).toLocaleString()}</div>
          <span class="tier-badge tier-badge-sm ${tierClass}">${e.tier || 'Bronze'}</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="subtle" style="padding:12px">Failed to load leaderboard</div>';
  }
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
    // Trigger deferred onboarding splash
    if (onboardingPendingAfterMnemonic) {
      onboardingPendingAfterMnemonic = false;
      setTimeout(() => launchOnboarding(), 300);
    }
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
    // Trigger deferred onboarding splash
    if (onboardingPendingAfterMnemonic) {
      onboardingPendingAfterMnemonic = false;
      setTimeout(() => launchOnboarding(), 300);
    }
  } catch (e) { const errEl = document.getElementById('recover-error'); errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

// ─── Theme Spin (Live-Cycling) ─────────────────────────────────────────────

const SPIN_BUBBLE_STYLES = ['modern', 'classic', 'minimal', 'rounded'];
const SPIN_ANIM_TYPES = ['none', 'drift', 'aurora', 'particles', 'mesh', 'fireflies'];

let spinTimer = null;
let spinRunning = false;
let spinDelay = 0;
let spinMultiplier = 1;
let spinIndex = 0;
let spinOrder = [];
let spinSavedPrefs = null;
let confettiParticles = [];
let confettiFrame = null;

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function quickApplyColors(preset, bubbleStyle) {
  const root = document.documentElement;
  const v = preset.vars;
  root.style.setProperty('--bg-primary', v.bgPrimary);
  root.style.setProperty('--bg-secondary', v.bgSecondary);
  root.style.setProperty('--bg-tertiary', v.bgTertiary);
  root.style.setProperty('--bg-hover', v.bgHover);
  root.style.setProperty('--bg-active', v.bgActive);
  root.style.setProperty('--border', v.border);
  root.style.setProperty('--text-primary', v.textPrimary);
  root.style.setProperty('--text-secondary', v.textSecondary);
  root.style.setProperty('--text-muted', v.textMuted);
  root.style.setProperty('--accent', v.accent);
  root.style.setProperty('--accent-hover', v.accentHover);
  root.style.setProperty('--green', v.green);
  root.style.setProperty('--red', v.red);
  root.style.setProperty('--orange', v.orange);
  root.style.setProperty('--msg-sent', v.msgSent);
  root.style.setProperty('--msg-received', v.msgReceived);
  root.style.setProperty('--radius', v.radius);
  root.style.setProperty('--radius-lg', v.radiusLg);

  document.body.classList.remove('bubble-modern', 'bubble-classic', 'bubble-minimal', 'bubble-rounded');
  if (bubbleStyle && bubbleStyle !== 'modern') {
    document.body.classList.add('bubble-' + bubbleStyle);
  }
}

function createSpinShapes() {
  const container = document.getElementById('spin-shapes');
  container.innerHTML = '';
  container.classList.remove('hidden');
  const types = ['circle', 'square', 'diamond', 'ring', 'hex', 'dot'];
  for (let i = 0; i < 30; i++) {
    const el = document.createElement('div');
    const type = types[Math.floor(Math.random() * types.length)];
    const size = 8 + Math.random() * 50;
    el.className = 'spin-shape spin-shape-' + type;
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.left = Math.random() * 100 + '%';
    el.style.top = (60 + Math.random() * 50) + '%';
    el.style.setProperty('--shape-opacity', (0.06 + Math.random() * 0.14).toFixed(2));
    el.style.setProperty('--drift-y', (-200 - Math.random() * 400) + 'px');
    el.style.setProperty('--drift-x', (-60 + Math.random() * 120) + 'px');
    el.style.setProperty('--drift-rot', (90 + Math.random() * 270) + 'deg');
    el.style.animationDuration = (3 + Math.random() * 5) + 's';
    el.style.animationDelay = (Math.random() * 4) + 's';
    container.appendChild(el);
  }
}

function removeSpinShapes() {
  const container = document.getElementById('spin-shapes');
  container.classList.add('hidden');
  container.innerHTML = '';
}

function startThemeSpin() {
  if (spinRunning) return;
  spinRunning = true;

  // Save current theme to revert if needed
  spinSavedPrefs = state.themePrefs ? { ...state.themePrefs } : null;

  // Shuffle theme order
  spinOrder = shuffleArray([...Array(THEME_PRESETS.length).keys()]);

  // Randomized timing for varied landing
  spinDelay = 55 + Math.random() * 15;
  const totalSteps = Math.floor(26 + Math.random() * 10);
  spinMultiplier = Math.pow(700 / spinDelay, 1 / totalSteps);
  spinIndex = 0;

  // UI setup
  document.getElementById('theme-wheel-hub').style.pointerEvents = 'none';
  document.getElementById('theme-wheel-hub').style.opacity = '0.4';
  const label = document.getElementById('theme-spin-label');
  label.classList.remove('hidden', 'landed');
  document.getElementById('theme-spin-result').classList.add('hidden');
  document.body.classList.add('theme-spinning');
  createSpinShapes();

  // Clear leftover confetti
  if (confettiFrame) { cancelAnimationFrame(confettiFrame); confettiFrame = null; }
  const cc = document.getElementById('confetti-canvas');
  cc.classList.add('hidden');

  spinTick();
}

function spinTick() {
  const presetIdx = spinOrder[spinIndex % spinOrder.length];
  const preset = THEME_PRESETS[presetIdx];
  const bubble = SPIN_BUBBLE_STYLES[Math.floor(Math.random() * SPIN_BUBBLE_STYLES.length)];

  // Apply theme colors + bubble style (lightweight, no DOM-heavy animations)
  quickApplyColors(preset, bubble);

  // Update label
  document.getElementById('theme-spin-name').textContent = preset.name;

  spinIndex++;
  spinDelay *= spinMultiplier;

  if (spinDelay > 700) {
    // Landed!
    landThemeSpin(preset);
    return;
  }

  spinTimer = setTimeout(spinTick, spinDelay);
}

function landThemeSpin(preset) {
  spinRunning = false;
  document.body.classList.remove('theme-spinning');

  // Pick a random bubble and animation for the final theme
  const bubble = SPIN_BUBBLE_STYLES[Math.floor(Math.random() * SPIN_BUBBLE_STYLES.length)];
  const anim = SPIN_ANIM_TYPES[Math.floor(Math.random() * SPIN_ANIM_TYPES.length)];

  const prefs = {
    presetId: preset.id,
    bubbleStyle: bubble,
    animationType: anim !== 'none' ? anim : undefined,
    animationSpeed: 'normal',
  };

  // Full apply (including animated background, caching, etc.)
  state.themePrefs = prefs;
  applyTheme(prefs);
  send('set_theme', prefs).catch(() => {});

  // Glow the label
  const label = document.getElementById('theme-spin-label');
  label.classList.add('landed');
  document.getElementById('theme-spin-result').classList.remove('hidden');

  // Show FAB again
  document.getElementById('theme-wheel-hub').style.pointerEvents = '';
  document.getElementById('theme-wheel-hub').style.opacity = '';

  // Remove shapes after a beat
  setTimeout(removeSpinShapes, 600);

  // Confetti
  const cc = document.getElementById('confetti-canvas');
  cc.classList.remove('hidden');
  fireConfetti([
    preset.vars.accent, preset.vars.accentHover,
    preset.vars.green, '#FFD700', '#ffffff', preset.vars.orange
  ]);
}

function keepSpinTheme() {
  document.getElementById('theme-spin-label').classList.add('hidden');
  if (confettiFrame) { cancelAnimationFrame(confettiFrame); confettiFrame = null; }
  const cc = document.getElementById('confetti-canvas');
  cc.classList.add('hidden');
  document.getElementById('theme-wheel-hub').classList.add('used');
  showToast('Theme saved!', state.themePrefs?.presetId || '', 'success');
}

function reSpinTheme() {
  document.getElementById('theme-spin-label').classList.add('hidden');
  if (confettiFrame) { cancelAnimationFrame(confettiFrame); confettiFrame = null; }
  const cc = document.getElementById('confetti-canvas');
  cc.classList.add('hidden');
  removeSpinShapes();

  // Revert to saved theme before re-spinning
  if (spinSavedPrefs) {
    applyTheme(spinSavedPrefs);
  }

  document.getElementById('theme-wheel-hub').classList.add('used');
  setTimeout(startThemeSpin, 200);
}

function fireConfetti(colors) {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  confettiParticles = [];
  const cx = canvas.width / 2;
  const cy = 80;

  for (let i = 0; i < 200; i++) {
    const angle = Math.random() * Math.PI;
    const speed = 3 + Math.random() * 8;
    confettiParticles.push({
      x: cx + (Math.random() - 0.5) * 200,
      y: cy,
      vx: Math.cos(angle) * speed * (Math.random() > 0.5 ? 1 : -1),
      vy: Math.sin(angle) * speed + 1,
      w: 4 + Math.random() * 7,
      h: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      life: 0
    });
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    for (const p of confettiParticles) {
      if (p.alpha <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.vx *= 0.99;
      p.rot += p.rotV;
      p.life++;
      if (p.life > 100) p.alpha -= 0.02;
      if (p.y > canvas.height + 30) p.alpha = 0;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (alive) {
      confettiFrame = requestAnimationFrame(tick);
    } else {
      document.getElementById('confetti-canvas').classList.add('hidden');
    }
  }

  tick();
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
  document.getElementById('message-input').addEventListener('input', () => sendTypingIndicator());

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

  // Drag-and-drop file sharing on chat area
  const chatArea = document.getElementById('chat-area');
  chatArea.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; chatArea.classList.add('drag-over'); });
  chatArea.addEventListener('dragleave', (e) => { if (!chatArea.contains(e.relatedTarget)) chatArea.classList.remove('drag-over'); });
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    chatArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file || !state.activeChat || state.activeChat.type !== 'dm') {
      if (!state.activeChat || state.activeChat.type !== 'dm') showToast('File sharing', 'Open a DM to share files');
      return;
    }
    (async () => {
      try {
        showToast('Sharing file...', file.name);
        await uploadFileChunked(file, 'share', state.activeChat.peerId);
        showToast('File shared!', file.name);
        refreshConversations();
      } catch (err) { showToast('Failed to share file', err.message); }
    })();
  });

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
  state.refreshTimer = setInterval(() => {
    if (state.connected) {
      refreshContacts();
      refreshConversations();
    }
  }, 10000);
});

// ─── Voice Channel (Hub Voice Mesh) ──────────────────────────────────────────

async function joinVoiceChannel(hubId, channelId, name) {
  // Already in this voice channel? No-op
  if (state.voiceChannel && state.voiceChannel.channelId === channelId) return;

  // Leave any current voice channel
  if (state.voiceChannel) leaveVoiceChannel();

  // End any active DM call
  if (state.callState) endCall();

  try {
    const rawVoice = await navigator.mediaDevices.getUserMedia(getAudioConstraints(false));
    state.voiceLocalStream = applyNoiseGate(rawVoice);
  } catch (e) {
    showToast('Microphone access denied', e.message);
    return;
  }

  state.voiceChannel = { hubId, channelId, name };
  state.voicePeers = {};
  state.voiceMuted = false;
  sfx.play('voiceJoin');

  // Show voice indicator + re-render channel list with users
  showVoiceStatusBar();
  updateVoiceIndicator();
  renderHubChannels();
  highlightVoiceHub();

  // Notify hub members we joined (staggered to avoid concurrent stream issues)
  const members = (state.hubMembers || []).filter(m => m.peerId !== state.myPeerId);
  for (let i = 0; i < members.length; i++) {
    setTimeout(() => {
      send('call_signal', {
        peerId: members[i].peerId,
        signal: { type: 'voice_join', hubId, channelId, name, fromName: state.myName },
      }).catch(() => {});
    }, i * 500); // 500ms between each notification
  }
}

function leaveVoiceChannel() {
  if (!state.voiceChannel) return;
  sfx.play('voiceLeave');

  // Notify peers we're leaving
  for (const peerId of Object.keys(state.voicePeers)) {
    send('call_signal', {
      peerId,
      signal: { type: 'voice_leave', hubId: state.voiceChannel.hubId, channelId: state.voiceChannel.channelId },
    }).catch(() => {});
  }

  // Close all peer connections
  for (const [, peer] of Object.entries(state.voicePeers)) {
    if (peer.pc) peer.pc.close();
  }

  // Stop local stream
  if (state.voiceLocalStream) {
    state.voiceLocalStream.getTracks().forEach(t => t.stop());
    state.voiceLocalStream = null;
  }

  state.voiceChannel = null;
  state.voicePeers = {};
  state.voiceMuted = false;

  // Hide voice status bar + indicator + re-render channels
  hideVoiceStatusBar();
  document.getElementById('voice-indicator').classList.add('hidden');
  highlightVoiceHub();
  if (state.speakingDetector) { clearInterval(state.speakingDetector); state.speakingDetector = null; }
  renderHubChannels();
}

function showVoiceStatusBar() {
  const bar = document.getElementById('voice-status-bar');
  bar.classList.remove('hidden');
  document.getElementById('voice-bar-channel-name').textContent = state.voiceChannel.name;
  updateVoiceMuteBtn();
}

function hideVoiceStatusBar() {
  document.getElementById('voice-status-bar').classList.add('hidden');
}

function updateVoiceMuteBtn() {
  const btn = document.getElementById('voice-mute-btn');
  if (!btn) return;
  if (state.voiceMuted) {
    btn.innerHTML = '&#128263;';
    btn.classList.add('active');
    btn.title = 'Unmute';
  } else {
    btn.innerHTML = '&#127908;';
    btn.classList.remove('active');
    btn.title = 'Mute';
  }
}

function toggleVoiceMute() {
  if (!state.voiceLocalStream) return;
  const track = state.voiceLocalStream.getAudioTracks()[0];
  if (track) {
    sfx.play('click');
    state.voiceMuted = !state.voiceMuted;
    track.enabled = !state.voiceMuted;
    updateVoiceMuteBtn();
    renderHubChannels();
  }
}

// Create a WebRTC peer connection for a voice channel peer
function createVoicePeerConnection(peerId, peerName) {
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send('call_signal', {
        peerId,
        signal: {
          type: 'voice_ice',
          candidate: event.candidate,
          hubId: state.voiceChannel.hubId,
          channelId: state.voiceChannel.channelId,
        },
      }).catch(() => {});
    }
  };

  pc.ontrack = (event) => {
    if (state.voicePeers[peerId]) {
      state.voicePeers[peerId].remoteStream = event.streams[0];
      // Play audio
      let audio = document.getElementById(`voice-audio-${peerId}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `voice-audio-${peerId}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = event.streams[0];
      // Start speaking detection and update indicator
      startSpeakingDetection();
      updateVoiceIndicator();
    }
  };

  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    if (cs === 'disconnected' || cs === 'failed' || cs === 'closed') {
      removeVoicePeer(peerId);
    }
  };

  // Add local tracks
  if (state.voiceLocalStream) {
    state.voiceLocalStream.getTracks().forEach(track => pc.addTrack(track, state.voiceLocalStream));
  }

  state.voicePeers[peerId] = { pc, remoteStream: null, name: peerName || peerId.slice(0, 12) };
  return pc;
}

function updateVoiceIndicator() {
  const el = document.getElementById('voice-indicator');
  if (!state.voiceChannel) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  document.getElementById('voice-indicator-channel').textContent = state.voiceChannel.name;

  // Find hub name
  const hubName = state.activeHub?.name || state.voiceChannel.hubId.slice(0, 8);
  document.getElementById('voice-indicator-hub').textContent = hubName;

  // Render user pills
  const usersEl = document.getElementById('voice-indicator-users');
  let usersHtml = `<div class="voice-user-pill ${state.voiceMuted ? '' : 'speaking'}" id="voice-pill-self">
    ${state.voiceMuted ? '' : '<span class="speaking-dot"></span>'}${escapeHtml(state.myName || 'You')}
  </div>`;
  for (const [peerId, peer] of Object.entries(state.voicePeers)) {
    const isSpeaking = state.speakingPeers && state.speakingPeers[peerId];
    usersHtml += `<div class="voice-user-pill ${isSpeaking ? 'speaking' : ''}" id="voice-pill-${escapeAttr(peerId)}">
      ${isSpeaking ? '<span class="speaking-dot"></span>' : ''}${escapeHtml(peer.name || peerId.slice(0, 12))}
    </div>`;
  }
  usersEl.innerHTML = usersHtml;

  // Update mute button
  const muteBtn = document.getElementById('voice-indicator-mute');
  if (muteBtn) {
    muteBtn.classList.toggle('muted', state.voiceMuted);
    muteBtn.innerHTML = state.voiceMuted ? '&#128263;' : '&#127908;';
  }
}

function highlightVoiceHub() {
  document.querySelectorAll('.hub-icon.in-voice').forEach(el => el.classList.remove('in-voice'));
  if (state.voiceChannel) {
    const icon = document.querySelector(`.hub-icon[data-hubid="${state.voiceChannel.hubId}"]`);
    if (icon) icon.classList.add('in-voice');
  }
}

// Speaking detection — monitor remote audio levels
function startSpeakingDetection() {
  if (state.speakingDetector) clearInterval(state.speakingDetector);
  if (!state.speakingPeers) state.speakingPeers = {};

  state.speakingDetector = setInterval(() => {
    let changed = false;
    for (const [peerId, peer] of Object.entries(state.voicePeers)) {
      if (!peer.analyser && peer.remoteStream) {
        try {
          const ctx = new AudioContext();
          const source = ctx.createMediaStreamSource(peer.remoteStream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          peer.analyser = analyser;
          peer.analyserData = new Uint8Array(analyser.frequencyBinCount);
        } catch {}
      }
      if (peer.analyser) {
        peer.analyser.getByteFrequencyData(peer.analyserData);
        const avg = peer.analyserData.reduce((sum, v) => sum + v, 0) / peer.analyserData.length;
        const wasSpeaking = !!state.speakingPeers[peerId];
        state.speakingPeers[peerId] = avg > 15;
        if (wasSpeaking !== state.speakingPeers[peerId]) changed = true;
      }
    }
    if (changed) updateVoiceIndicator();
  }, 200);
}

function removeVoicePeer(peerId) {
  const peer = state.voicePeers[peerId];
  if (peer) {
    sfx.play('voiceLeave');
    if (peer.pc) peer.pc.close();
    const audio = document.getElementById(`voice-audio-${peerId}`);
    if (audio) audio.remove();
    delete state.voicePeers[peerId];
    if (state.speakingPeers) delete state.speakingPeers[peerId];
    renderHubChannels();
    updateVoiceIndicator();
  }
}

// Handle voice-related signals in the existing onCallSignal flow
function handleVoiceSignal(data) {
  const signal = data.signal;
  const fromId = data.from;
  const fromName = data.fromName || fromId?.slice(0, 12);

  if (signal.type === 'voice_join') {
    // Track who's in which voice channel (even if we haven't joined)
    if (!state.voiceOccupancy) state.voiceOccupancy = {};
    const vcKey = `${signal.hubId}:${signal.channelId}`;
    if (!state.voiceOccupancy[vcKey]) state.voiceOccupancy[vcKey] = {};
    state.voiceOccupancy[vcKey][fromId] = { name: signal.fromName || fromName, joinedAt: Date.now() };
    renderHubChannels();

    // If we're not in this channel, don't create WebRTC offer
    if (!state.voiceChannel) return;
    if (signal.hubId !== state.voiceChannel.hubId || signal.channelId !== state.voiceChannel.channelId) return;
    if (state.voicePeers[fromId]) return; // Already connected
    sfx.play('voiceJoin');

    // Delay offer slightly to let the joiner's connection stabilize
    setTimeout(async () => {
      try {
        const pc = createVoicePeerConnection(fromId, signal.fromName || fromName);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await send('call_signal', {
          peerId: fromId,
          signal: {
            type: 'voice_offer',
            sdp: offer.sdp,
            hubId: state.voiceChannel.hubId,
            channelId: state.voiceChannel.channelId,
            fromName: state.myName,
          },
        });
        renderHubChannels();
      } catch (e) { console.error('[Voice] Failed to create offer:', e); }
    }, 1000);

  } else if (signal.type === 'voice_offer') {
    // Received an offer — if we're in the same channel, create answer
    if (!state.voiceChannel) return;
    if (signal.hubId !== state.voiceChannel.hubId || signal.channelId !== state.voiceChannel.channelId) return;

    (async () => {
      try {
        const pc = createVoicePeerConnection(fromId, signal.fromName || fromName);
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await send('call_signal', {
          peerId: fromId,
          signal: {
            type: 'voice_answer',
            sdp: answer.sdp,
            hubId: state.voiceChannel.hubId,
            channelId: state.voiceChannel.channelId,
          },
        });
        renderHubChannels();
      } catch (e) { console.error('[Voice] Failed to create answer:', e); }
    })();

  } else if (signal.type === 'voice_answer') {
    // Set remote description on existing connection
    if (!state.voicePeers[fromId]) return;
    const peer = state.voicePeers[fromId];
    peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }))
      .then(() => {
        // Flush queued ICE candidates
        if (peer.iceQueue) {
          for (const c of peer.iceQueue) peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          peer.iceQueue = [];
        }
      })
      .catch(e => console.error('[Voice] Failed to set answer:', e));

  } else if (signal.type === 'voice_ice') {
    // Add ICE candidate (queue if remote description not set yet)
    if (!state.voicePeers[fromId]) return;
    const peer = state.voicePeers[fromId];
    if (peer.pc.remoteDescription) {
      peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
    } else {
      // Queue for later
      if (!peer.iceQueue) peer.iceQueue = [];
      peer.iceQueue.push(signal.candidate);
    }

  } else if (signal.type === 'voice_leave') {
    // Remove from occupancy tracking
    if (state.voiceOccupancy) {
      for (const key of Object.keys(state.voiceOccupancy)) {
        if (state.voiceOccupancy[key][fromId]) {
          delete state.voiceOccupancy[key][fromId];
          if (Object.keys(state.voiceOccupancy[key]).length === 0) delete state.voiceOccupancy[key];
        }
      }
    }
    removeVoicePeer(fromId);
    renderHubChannels();
  }
}

// ─── Onboarding Walkthrough ──────────────────────────────────────────────────

const ONBOARDING_STEPS = [
  { target: '#identity-bar', tab: null, title: 'Your Identity', desc: 'This is you. Your identity is a cryptographic keypair \u2014 no email, no password, no server. Back it up with your 12-word mnemonic phrase.' },
  { target: '.tab[data-tab="feed"]', tab: 'feed', title: 'Broadcast', desc: 'Share posts, photos, videos, polls, and voice notes with your network. Toggle between public and friends-only.' },
  { target: '.tab[data-tab="chats"]', tab: 'chats', title: 'Chats', desc: 'End-to-end encrypted direct messages with forward secrecy. Even if a key is compromised, past messages stay safe.' },
  { target: '.tab[data-tab="contacts"]', tab: 'contacts', title: 'Contacts', desc: 'Your trusted peers. Add contacts via friend requests or invite codes. Keys are pinned on first contact (TOFU).' },
  { target: '.tab[data-tab="groups"]', tab: 'groups', title: 'Groups', desc: 'Private group chats with automatic key rotation. When someone leaves, the encryption key changes.' },
  { target: '.tab[data-tab="discover"]', tab: 'discover', title: 'Discover', desc: 'Find peers on the network, send friend requests, and browse who is online.' },
  { target: '.tab[data-tab="deaddrops"]', tab: 'deaddrops', title: 'Dead Drops', desc: 'Post anonymously via 3-hop onion routing. No identity attached \u2014 not even a timestamp from your device.' },
  { target: '#hub-strip', tab: null, title: 'Hubs', desc: 'Community spaces with text channels and voice chat. Create your own or browse existing ones.' },
  { target: '#btn-connect-peer', tab: null, title: 'Connect Peer', desc: 'Share an invite code to connect with peers across networks. Copy your code or paste a friend\u2019s.' },
  { target: '#btn-settings', tab: null, title: 'Settings', desc: 'Customize themes, privacy, data, and configure a Dead Man\'s Switch. You can replay this tour anytime from here.' },
];

let onboardingStep = 0;
let onboardingActive = false;
let onboardingPendingAfterMnemonic = false;

function launchOnboarding() {
  // Close settings modal if open
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal && !settingsModal.classList.contains('hidden')) {
    settingsModal.classList.add('hidden');
  }
  // Show splash
  document.getElementById('onboarding-splash').classList.remove('hidden');
}

function startOnboardingTour() {
  document.getElementById('onboarding-splash').classList.add('hidden');
  onboardingStep = 0;
  onboardingActive = true;
  const overlay = document.getElementById('onboarding-overlay');
  overlay.classList.remove('hidden');
  overlay.classList.add('active');
  showOnboardingStep();
}

function finishOnboarding() {
  onboardingActive = false;
  const overlay = document.getElementById('onboarding-overlay');
  overlay.classList.add('hidden');
  overlay.classList.remove('active');
  cleanupSpotlightTarget();
  localStorage.setItem('decentra_onboarded', '1');
}

function showOnboardingStep() {
  const step = ONBOARDING_STEPS[onboardingStep];
  if (!step) { finishOnboarding(); return; }

  // Switch tab if needed
  if (step.tab) {
    const tabBtn = document.querySelector(`.tab[data-tab="${step.tab}"]`);
    if (tabBtn) tabBtn.click();
  }

  const target = document.querySelector(step.target);
  if (!target || target.offsetParent === null) {
    // Target not visible — skip this step
    if (onboardingStep < ONBOARDING_STEPS.length - 1) {
      onboardingStep++;
      showOnboardingStep();
    } else {
      finishOnboarding();
    }
    return;
  }

  // Position spotlight
  const rect = target.getBoundingClientRect();
  const pad = 6;
  const spotlight = document.getElementById('onboarding-spotlight');
  spotlight.style.top = (rect.top - pad) + 'px';
  spotlight.style.left = (rect.left - pad) + 'px';
  spotlight.style.width = (rect.width + pad * 2) + 'px';
  spotlight.style.height = (rect.height + pad * 2) + 'px';

  // Elevate target
  cleanupSpotlightTarget();
  target.classList.add('onboarding-spotlight-target');

  // Fill tooltip
  document.getElementById('onboarding-tooltip-title').textContent = step.title;
  document.getElementById('onboarding-tooltip-desc').textContent = step.desc;
  document.getElementById('onboarding-step-indicator').textContent = `${onboardingStep + 1} / ${ONBOARDING_STEPS.length}`;

  const btnBack = document.getElementById('onboarding-btn-back');
  const btnNext = document.getElementById('onboarding-btn-next');
  btnBack.style.display = onboardingStep === 0 ? 'none' : '';
  btnNext.textContent = onboardingStep === ONBOARDING_STEPS.length - 1 ? 'Done' : 'Next';

  positionTooltip(rect);
}

function positionTooltip(targetRect) {
  const tooltip = document.getElementById('onboarding-tooltip');
  const pad = 12;
  const tooltipW = 300;
  let top, left;

  // If target is near the left edge, position tooltip to the right of it
  if (targetRect.left < 80) {
    top = targetRect.top + (targetRect.height / 2) - 60;
    left = targetRect.right + pad;
    // Clamp vertical
    if (top < 8) top = 8;
    if (top + 160 > window.innerHeight - 8) top = window.innerHeight - 168;
  // If target is near the right edge, position tooltip to the left of it
  } else if (targetRect.right > window.innerWidth - 80) {
    top = targetRect.top + (targetRect.height / 2) - 60;
    left = targetRect.left - tooltipW - pad;
    if (top < 8) top = 8;
    if (left < 8) left = 8;
  } else {
    // Default: below the target, centered
    top = targetRect.bottom + pad;
    left = targetRect.left + (targetRect.width / 2) - (tooltipW / 2);
  }

  // Clamp horizontal
  if (left < 8) left = 8;
  if (left + tooltipW > window.innerWidth - 8) left = window.innerWidth - tooltipW - 8;

  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.style.bottom = '';

  // Check if it overflows bottom (only for below-target placement)
  requestAnimationFrame(() => {
    const tooltipRect = tooltip.getBoundingClientRect();
    if (tooltipRect.bottom > window.innerHeight - 8) {
      tooltip.style.top = (targetRect.top - tooltipRect.height - pad) + 'px';
      if (parseFloat(tooltip.style.top) < 8) {
        tooltip.style.top = '8px';
      }
    }
  });
}

function cleanupSpotlightTarget() {
  const prev = document.querySelector('.onboarding-spotlight-target');
  if (prev) prev.classList.remove('onboarding-spotlight-target');
}

function onboardingNext() {
  if (onboardingStep >= ONBOARDING_STEPS.length - 1) {
    finishOnboarding();
  } else {
    onboardingStep++;
    showOnboardingStep();
  }
}

function onboardingBack() {
  if (onboardingStep > 0) {
    onboardingStep--;
    showOnboardingStep();
  }
}

// Wire up onboarding buttons
document.getElementById('onboarding-btn-tour').addEventListener('click', startOnboardingTour);
document.getElementById('onboarding-btn-skip-splash').addEventListener('click', () => {
  document.getElementById('onboarding-splash').classList.add('hidden');
  localStorage.setItem('decentra_onboarded', '1');
});
document.getElementById('onboarding-btn-next').addEventListener('click', onboardingNext);
document.getElementById('onboarding-btn-back').addEventListener('click', onboardingBack);
document.getElementById('onboarding-btn-skip').addEventListener('click', finishOnboarding);

// Reposition on resize
window.addEventListener('resize', debounce(() => {
  if (!onboardingActive) return;
  showOnboardingStep();
}, 150));

// ─── Dead Man's Switch ──────────────────────────────────────────────────

let dmsCountdownTimer = null;

function showDMSModal() {
  // Close settings modal
  document.getElementById('settings-modal').classList.add('hidden');
  const modal = document.getElementById('dms-modal');

  // Populate contact picker
  const picker = document.getElementById('dms-contact-picker');
  const contacts = state.contacts || [];
  picker.innerHTML = contacts.length === 0
    ? '<p class="subtle">No contacts yet.</p>'
    : contacts.map(c => `<label class="member-option"><input type="checkbox" value="${escapeHtml(c.peerId)}" class="dms-recipient-cb"> ${escapeHtml(c.displayName || c.peerId.slice(0, 12))}</label>`).join('');

  // Wire char counter
  const input = document.getElementById('dms-message-input');
  const counter = document.getElementById('dms-char-counter');
  input.value = '';
  counter.textContent = '0/2000';
  input.oninput = () => { counter.textContent = `${input.value.length}/2000`; };

  // Load active switches
  loadDMSSwitches();

  modal.classList.remove('hidden');
}

function closeDMSModal() {
  document.getElementById('dms-modal').classList.add('hidden');
  if (dmsCountdownTimer) { clearInterval(dmsCountdownTimer); dmsCountdownTimer = null; }
}

async function loadDMSSwitches() {
  try {
    const switches = await send('dms_list');
    renderDMSSwitches(switches || []);
  } catch {
    document.getElementById('dms-active-list').innerHTML = '<p class="subtle">Failed to load switches.</p>';
  }
}

function renderDMSSwitches(switches) {
  const container = document.getElementById('dms-active-list');
  if (!switches || switches.length === 0) {
    container.innerHTML = '<p class="subtle">No active switches.</p>';
    if (dmsCountdownTimer) { clearInterval(dmsCountdownTimer); dmsCountdownTimer = null; }
    return;
  }

  container.innerHTML = switches.map(s => {
    const statusClass = 'dms-status-' + s.status;
    const statusLabel = s.status.charAt(0).toUpperCase() + s.status.slice(1);
    const msgPreview = (s.message || '').slice(0, 80) + (s.message.length > 80 ? '...' : '');
    const recipientCount = s.recipientIds ? s.recipientIds.length : 0;
    const windowLabel = formatDMSWindow(s.windowMs);
    return `<div class="dms-switch-card" data-switch-id="${s.switchId}">
      <div class="dms-card-header">
        <span class="${statusClass}">${statusLabel}</span>
        <span class="dms-countdown ${statusClass}" data-remaining="${s.timeRemaining || 0}">${s.status === 'armed' ? formatDMSCountdown(s.timeRemaining) : ''}</span>
      </div>
      <div class="dms-message-preview">${escapeHtml(msgPreview)}</div>
      <div class="subtle" style="font-size:0.8em;margin-bottom:6px">${recipientCount} recipient${recipientCount !== 1 ? 's' : ''} &middot; ${windowLabel}</div>
      <div class="dms-card-actions">
        ${s.status === 'armed' ? `<button class="btn-secondary" onclick="disarmDMS('${s.switchId}')">Disarm</button>` : ''}
        <button class="btn-secondary" onclick="deleteDMS('${s.switchId}')">Delete</button>
      </div>
    </div>`;
  }).join('');

  // Start countdown update timer
  if (dmsCountdownTimer) clearInterval(dmsCountdownTimer);
  dmsCountdownTimer = setInterval(() => {
    document.querySelectorAll('.dms-countdown[data-remaining]').forEach(el => {
      let remaining = parseInt(el.dataset.remaining, 10);
      if (remaining > 0) {
        remaining -= 60000;
        if (remaining < 0) remaining = 0;
        el.dataset.remaining = remaining;
        el.textContent = formatDMSCountdown(remaining);
      }
    });
  }, 60000);
}

function formatDMSCountdown(ms) {
  if (!ms || ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainHours = hours % 24;
    return `${days}d ${remainHours}h`;
  }
  return `${hours}h ${mins}m`;
}

function formatDMSWindow(ms) {
  if (ms >= 7 * 24 * 3600000) return '7 days';
  if (ms >= 3 * 24 * 3600000) return '3 days';
  if (ms >= 24 * 3600000) return '24 hours';
  return '12 hours';
}

function onDMSWindowChange() {
  const select = document.getElementById('dms-window-select');
  const customDiv = document.getElementById('dms-custom-window');
  if (select.value === 'custom') {
    customDiv.classList.remove('hidden');
    customDiv.style.display = 'flex';
  } else {
    customDiv.classList.add('hidden');
  }
}

function getDMSWindowMs() {
  const select = document.getElementById('dms-window-select');
  if (select.value === 'custom') {
    const val = parseInt(document.getElementById('dms-custom-value').value, 10);
    const unit = parseInt(document.getElementById('dms-custom-unit').value, 10);
    if (!val || val < 1) return 0;
    return val * unit;
  }
  return parseInt(select.value, 10);
}

async function createDMS() {
  const message = document.getElementById('dms-message-input').value.trim();
  if (!message) { showToast('Error', 'Message is required', 'error'); return; }

  const checkboxes = document.querySelectorAll('.dms-recipient-cb:checked');
  const recipientIds = Array.from(checkboxes).map(cb => cb.value);
  if (recipientIds.length === 0) { showToast('Error', 'Select at least one recipient', 'error'); return; }

  const windowMs = getDMSWindowMs();
  if (!windowMs || windowMs < 3600000 || windowMs > 30 * 86400000) {
    showToast('Error', 'Window must be between 1 hour and 30 days', 'error');
    return;
  }

  try {
    await send('dms_create', { recipientIds, message, windowMs });
    showToast('Switch Created', 'Dead Man\'s Switch is now armed', 'success');
    document.getElementById('dms-message-input').value = '';
    document.querySelectorAll('.dms-recipient-cb').forEach(cb => { cb.checked = false; });
    loadDMSSwitches();
  } catch (err) {
    showToast('Error', err.message || 'Failed to create switch', 'error');
  }
}

async function disarmDMS(switchId) {
  try {
    await send('dms_disarm', { switchId });
    showToast('Disarmed', 'Switch has been disarmed', 'success');
    loadDMSSwitches();
  } catch (err) {
    showToast('Error', err.message || 'Failed to disarm', 'error');
  }
}

async function deleteDMS(switchId) {
  try {
    await send('dms_delete', { switchId });
    showToast('Deleted', 'Switch removed', 'success');
    loadDMSSwitches();
  } catch (err) {
    showToast('Error', err.message || 'Failed to delete', 'error');
  }
}
