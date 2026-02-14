/**
 * DecentraNet Browser Frontend
 *
 * - WebSocket client connecting to local Node.js backend
 * - Chat UI (DMs, groups, file sharing)
 * - WebRTC voice/video calls using native browser APIs
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
  messages: [],
  pendingRequests: {},     // id -> { resolve, reject }
  receivedFiles: {},       // contentId -> fileInfo
  // WebRTC
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  callState: null,         // null | 'calling' | 'incoming' | 'connected'
  callPeerId: null,
  callPeerName: null,
  callType: null,          // 'voice' | 'video'
  callTimer: null,
  callStartTime: null,
  iceCandidateQueue: [],
  pendingOffer: null,    // stored SDP offer waiting for user to accept
};

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connectWS() {
  const wsUrl = `ws://${window.location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    setConnectionStatus('online');
    send('get_identity').then((data) => {
      state.myPeerId = data.peerId;
      state.myName = data.displayName;
      document.getElementById('my-name').textContent = data.displayName || 'Anonymous';
      document.getElementById('my-id').textContent = data.peerId;
    });
    refreshAll();
  };

  state.ws.onclose = () => {
    setConnectionStatus('offline');
    state.connected = false;
    setTimeout(connectWS, 3000);
  };

  state.ws.onerror = () => {};

  state.ws.onmessage = (event) => {
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
  };
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
    case 'message':
      onIncomingMessage(data);
      break;
    case 'group_message':
      onIncomingGroupMessage(data);
      break;
    case 'peer_online':
      showToast(`${data.displayName || 'Peer'} is online`, data.peerId);
      refreshContacts();
      refreshConversations();
      break;
    case 'peer_offline':
      showToast(`${data.displayName || 'Peer'} went offline`);
      refreshContacts();
      break;
    case 'file_received':
      onFileReceived(data);
      break;
    case 'call_signal':
      onCallSignal(data);
      break;
  }
}

function onIncomingMessage(data) {
  // If we're viewing this conversation, append and refresh
  const convoId = [state.myPeerId, data.from].sort().join(':');
  if (state.activeChat && state.activeChat.id === convoId) {
    appendMessage({
      from: data.from,
      body: data.body,
      timestamp: data.timestamp,
      status: 'delivered',
    });
  }

  showToast(`${data.fromName}: ${data.body.slice(0, 50)}`);
  refreshConversations();
}

function onIncomingGroupMessage(data) {
  const convoId = `group:${data.groupId}`;
  if (state.activeChat && state.activeChat.id === convoId) {
    appendMessage({
      from: data.from,
      fromName: data.fromName,
      body: data.body,
      timestamp: data.timestamp,
      status: 'delivered',
    });
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

  showToast(
    `${data.fromName} shared a file`,
    `${data.fileInfo.fileName} (${formatBytes(data.fileInfo.fileSize)})`
  );
  refreshConversations();
}

// ─── Data Refresh ───────────────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([
    refreshContacts(),
    refreshConversations(),
    refreshGroups(),
  ]);
}

async function refreshContacts() {
  try {
    state.contacts = await send('get_contacts');
    renderContacts();
  } catch (e) { console.error('Failed to refresh contacts:', e); }
}

async function refreshConversations() {
  try {
    state.conversations = await send('get_conversations');
    renderConversations();
  } catch (e) { console.error('Failed to refresh conversations:', e); }
}

async function refreshGroups() {
  try {
    state.groups = await send('get_groups');
    renderGroups();
  } catch (e) { console.error('Failed to refresh groups:', e); }
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
    if (date !== lastDate) {
      lastDate = date;
      el.innerHTML += `<div class="date-separator">${date}</div>`;
    }

    const isMine = m.from === state.myPeerId;
    const time = formatTime(m.timestamp);

    // Check if it's a file message
    if (m.type === 'file') {
      try {
        const fileInfo = JSON.parse(m.body);
        state.receivedFiles[fileInfo.contentId] = fileInfo;
        const senderName = isMine ? 'You' : (state.contacts.find(c => c.peerId === m.from)?.displayName || m.from.slice(0, 12));
        el.innerHTML += renderFileMessageHTML(isMine, senderName, fileInfo, time);
        continue;
      } catch {}
    }

    let senderHTML = '';
    if (!isMine && state.activeChat && state.activeChat.type === 'group') {
      const contact = state.contacts.find((c) => c.peerId === m.from);
      const name = contact?.displayName || m.from.slice(0, 12);
      senderHTML = `<div class="msg-sender">${escapeHtml(name)}</div>`;
    }

    el.innerHTML += `
      <div class="message ${isMine ? 'sent' : 'received'}">
        ${senderHTML}
        <div class="msg-body">${escapeHtml(m.body)}</div>
        <div class="msg-time">${time} ${isMine ? `<span class="msg-status">${m.status || ''}</span>` : ''}</div>
      </div>`;
  }

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

// ─── Chat Navigation ────────────────────────────────────────────────────────

async function openConversation(conversationId, displayName, isGroup) {
  const type = isGroup ? 'group' : 'dm';
  let peerId = null;
  let groupId = null;

  if (isGroup) {
    groupId = conversationId.replace('group:', '');
  } else {
    // Extract peer ID from conversation ID
    const parts = conversationId.split(':');
    peerId = parts.find((p) => p !== state.myPeerId) || parts[0];
  }

  state.activeChat = { type, id: conversationId, peerId, groupId, name: displayName };

  // Show chat area
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('active-chat').classList.remove('hidden');
  document.getElementById('chat-peer-name').textContent = displayName;

  // Show/hide call buttons for groups
  const callBtns = document.getElementById('chat-actions');
  callBtns.style.display = type === 'dm' ? 'flex' : 'none';

  // Mark active in sidebar
  document.querySelectorAll('.list-item').forEach((el) => el.classList.remove('active'));

  // Load history
  try {
    const messages = await send('get_history', { conversationId, limit: 100 });
    state.messages = messages;
    renderMessages(messages);
  } catch (e) {
    console.error('Failed to load history:', e);
  }
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
    if (state.activeChat.type === 'dm') {
      await send('send_message', { to: state.activeChat.peerId, text });
    } else {
      await send('send_group_message', { groupId: state.activeChat.groupId, text });
    }

    appendMessage({
      from: state.myPeerId,
      body: text,
      timestamp: Date.now(),
      status: 'sent',
    });

    refreshConversations();
  } catch (e) {
    showToast('Failed to send message', e.message);
  }
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
    const base64 = btoa(
      new Uint8Array(reader.result).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    try {
      showToast('Sharing file...', file.name);
      await send('share_file', {
        recipientId: state.activeChat.peerId,
        fileName: file.name,
        fileData: base64,
      });
      showToast('File shared!', file.name);
      refreshConversations();
    } catch (e) {
      showToast('Failed to share file', e.message);
    }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

async function downloadFile(contentId) {
  const fileInfo = state.receivedFiles[contentId];
  if (!fileInfo) {
    showToast('File info not found');
    return;
  }

  try {
    showToast('Downloading...', fileInfo.fileName);
    const result = await send('download_file', { fileInfo });

    // Create blob and trigger download
    const binary = atob(result.fileData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const blob = new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(url);

    showToast('Downloaded!', result.fileName);
  } catch (e) {
    showToast('Download failed', e.message);
  }
}

// ─── Group Creation ─────────────────────────────────────────────────────────

function showGroupModal() {
  const modal = document.getElementById('group-modal');
  const membersList = document.getElementById('group-members-list');

  membersList.innerHTML = state.contacts.map((c) => `
    <label class="member-option">
      <input type="checkbox" value="${c.peerId}">
      ${escapeHtml(c.displayName || c.peerId.slice(0, 16))}
    </label>`
  ).join('');

  document.getElementById('group-name-input').value = '';
  modal.classList.remove('hidden');
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) return;

  const checked = document.querySelectorAll('#group-members-list input:checked');
  const members = Array.from(checked).map((el) => el.value);
  if (members.length === 0) {
    showToast('Select at least one member');
    return;
  }

  try {
    const result = await send('create_group', { name, members });
    document.getElementById('group-modal').classList.add('hidden');
    showToast('Group created!', name);
    refreshGroups();
    openGroup(result.groupId, name);
  } catch (e) {
    showToast('Failed to create group', e.message);
  }
}

// ─── Connect Peer (Invite Codes) ─────────────────────────────────────────────

async function showConnectModal() {
  const modal = document.getElementById('connect-modal');
  const display = document.getElementById('invite-code-display');
  display.textContent = 'Loading...';
  modal.classList.remove('hidden');

  try {
    const result = await send('get_invite_code');
    display.textContent = result.code;
  } catch (e) {
    display.textContent = 'Failed to load invite code';
  }
}

async function copyInviteCode() {
  const code = document.getElementById('invite-code-display').textContent;
  if (!code || code === 'Loading...' || code === 'Failed to load invite code') return;

  try {
    await navigator.clipboard.writeText(code);
    showToast('Invite code copied!');
  } catch {
    // Fallback: select the text
    const el = document.getElementById('invite-code-display');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    showToast('Select and copy manually (Ctrl+C)');
  }
}

async function connectWithInvite() {
  const input = document.getElementById('connect-code-input');
  const code = input.value.trim();
  if (!code) {
    showToast('Paste an invite code first');
    return;
  }

  try {
    showToast('Connecting...');
    const result = await send('connect_peer', { code });
    showToast('Connected!', result.name || result.peerId);
    input.value = '';
    document.getElementById('connect-modal').classList.add('hidden');
    refreshContacts();
    refreshConversations();
  } catch (e) {
    showToast('Connection failed', e.message);
  }
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
    // Get local media
    const constraints = {
      audio: true,
      video: type === 'video',
    };
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    if (type === 'video') {
      document.getElementById('local-video').srcObject = state.localStream;
      document.getElementById('video-container').classList.remove('hidden');
      document.getElementById('btn-toggle-video').classList.remove('hidden');
    }

    // Create peer connection
    createPeerConnection();

    // Add local tracks
    state.localStream.getTracks().forEach((track) => {
      state.peerConnection.addTrack(track, state.localStream);
    });

    // Create and send offer
    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);

    await send('call_signal', {
      peerId: state.callPeerId,
      signal: { type: 'offer', sdp: offer.sdp, callType: type },
    });

  } catch (e) {
    console.error('Failed to start call:', e);
    showToast('Call failed', e.message);
    endCall();
  }
}

function createPeerConnection() {
  state.peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  state.peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      send('call_signal', {
        peerId: state.callPeerId,
        signal: { type: 'ice-candidate', candidate: event.candidate },
      }).catch(() => {});
    }
  };

  state.peerConnection.ontrack = (event) => {
    state.remoteStream = event.streams[0];
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = event.streams[0];

    if (state.callType === 'video') {
      document.getElementById('video-container').classList.remove('hidden');
    }
  };

  state.peerConnection.onconnectionstatechange = () => {
    const cs = state.peerConnection.connectionState;
    if (cs === 'connected') {
      state.callState = 'connected';
      updateCallStatus('Connected');
      startCallTimer();
    } else if (cs === 'disconnected' || cs === 'failed' || cs === 'closed') {
      endCall();
    }
  };
}

async function onCallSignal(data) {
  const signal = data.signal;

  if (signal.type === 'offer') {
    // Incoming call — store the offer and show accept/reject UI
    state.callPeerId = data.from;
    state.callPeerName = data.fromName;
    state.callType = signal.callType || 'voice';
    state.callState = 'incoming';
    state.iceCandidateQueue = [];
    state.pendingOffer = signal;

    showCallUI();
    updateCallStatus(`Incoming ${state.callType} call...`);
    // Show accept/reject, hide in-call controls
    document.getElementById('incoming-call-controls').classList.remove('hidden');
    document.getElementById('call-controls').classList.add('hidden');

  } else if (signal.type === 'answer') {
    if (state.peerConnection) {
      await state.peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: signal.sdp })
      );
      // Process queued ICE candidates
      for (const candidate of state.iceCandidateQueue) {
        await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
      state.iceCandidateQueue = [];
    }

  } else if (signal.type === 'ice-candidate') {
    if (state.peerConnection && state.peerConnection.remoteDescription) {
      await state.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } else {
      state.iceCandidateQueue.push(signal.candidate);
    }

  } else if (signal.type === 'hangup') {
    endCall();
  }
}

function endCall() {
  if (state.callPeerId && state.callState) {
    send('call_signal', {
      peerId: state.callPeerId,
      signal: { type: 'hangup' },
    }).catch(() => {});
  }

  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  state.remoteStream = null;
  state.callState = null;
  state.callPeerId = null;
  state.callPeerName = null;

  if (state.callTimer) {
    clearInterval(state.callTimer);
    state.callTimer = null;
  }

  hideCallUI();
}

async function acceptCall() {
  if (!state.pendingOffer || state.callState !== 'incoming') return;

  const signal = state.pendingOffer;
  state.pendingOffer = null;

  // Switch to in-call controls
  document.getElementById('incoming-call-controls').classList.add('hidden');
  document.getElementById('call-controls').classList.remove('hidden');
  updateCallStatus('Connecting...');

  try {
    const constraints = {
      audio: true,
      video: state.callType === 'video',
    };
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    if (state.callType === 'video') {
      document.getElementById('local-video').srcObject = state.localStream;
      document.getElementById('video-container').classList.remove('hidden');
      document.getElementById('btn-toggle-video').classList.remove('hidden');
    }

    createPeerConnection();

    state.localStream.getTracks().forEach((track) => {
      state.peerConnection.addTrack(track, state.localStream);
    });

    await state.peerConnection.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp: signal.sdp })
    );

    // Process queued ICE candidates
    for (const candidate of state.iceCandidateQueue) {
      await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
    state.iceCandidateQueue = [];

    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);

    await send('call_signal', {
      peerId: state.callPeerId,
      signal: { type: 'answer', sdp: answer.sdp },
    });

  } catch (e) {
    console.error('Failed to accept call:', e);
    showToast('Call failed', e.message);
    endCall();
  }
}

function rejectCall() {
  if (state.callPeerId) {
    send('call_signal', {
      peerId: state.callPeerId,
      signal: { type: 'hangup' },
    }).catch(() => {});
  }
  state.pendingOffer = null;
  state.callState = null;
  state.callPeerId = null;
  state.callPeerName = null;
  hideCallUI();
}

function toggleMute() {
  if (!state.localStream) return;
  const audioTrack = state.localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    document.getElementById('btn-toggle-mute').classList.toggle('active', !audioTrack.enabled);
    document.getElementById('btn-toggle-mute').textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
  }
}

function toggleVideo() {
  if (!state.localStream) return;
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    document.getElementById('btn-toggle-video').classList.toggle('active', !videoTrack.enabled);
    document.getElementById('btn-toggle-video').textContent = videoTrack.enabled ? 'Camera Off' : 'Camera On';
  }
}

// ─── Call UI ────────────────────────────────────────────────────────────────

function showCallUI() {
  document.getElementById('call-overlay').classList.remove('hidden');
  document.getElementById('call-peer-name').textContent = state.callPeerName || 'Unknown';
  document.getElementById('call-timer').textContent = '';

  // For outgoing calls, show in-call controls; for incoming, the caller shows accept/reject
  if (state.callState === 'incoming') {
    document.getElementById('incoming-call-controls').classList.remove('hidden');
    document.getElementById('call-controls').classList.add('hidden');
  } else {
    document.getElementById('incoming-call-controls').classList.add('hidden');
    document.getElementById('call-controls').classList.remove('hidden');
  }

  if (state.callType === 'video') {
    document.getElementById('video-container').classList.remove('hidden');
    document.getElementById('btn-toggle-video').classList.remove('hidden');
  } else {
    document.getElementById('video-container').classList.add('hidden');
    document.getElementById('btn-toggle-video').classList.add('hidden');
  }
}

function hideCallUI() {
  document.getElementById('call-overlay').classList.add('hidden');
  document.getElementById('video-container').classList.add('hidden');
  document.getElementById('local-video').srcObject = null;
  document.getElementById('remote-video').srcObject = null;
}

function updateCallStatus(text) {
  document.getElementById('call-status').textContent = text;
}

function startCallTimer() {
  state.callStartTime = Date.now();
  state.callTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    document.getElementById('call-timer').textContent = `${mins}:${secs}`;
  }, 1000);
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
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
  toast.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    ${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Event Bindings ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Send message
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

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

  // Group creation
  document.getElementById('btn-create-group').addEventListener('click', showGroupModal);
  document.getElementById('btn-cancel-group').addEventListener('click', () => {
    document.getElementById('group-modal').classList.add('hidden');
  });
  document.getElementById('btn-confirm-group').addEventListener('click', createGroup);

  // Connect peer
  document.getElementById('btn-connect-peer').addEventListener('click', showConnectModal);
  document.getElementById('btn-copy-invite').addEventListener('click', copyInviteCode);
  document.getElementById('btn-connect-invite').addEventListener('click', connectWithInvite);
  document.getElementById('btn-cancel-connect').addEventListener('click', () => {
    document.getElementById('connect-modal').classList.add('hidden');
  });

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
