const socket = io();
let localStream = null;
let screenStream = null;
let currentRoomId = null;
let userName = null;

// peerConnections: peerId -> RTCPeerConnection
const peers = new Map();

// ICE servers (Google STUN)
const rtcConfig = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
};

const els = {
  createBtn: document.getElementById('createRoomBtn'),
  joinBtn: document.getElementById('joinRoomBtn'),
  roomCodeInput: document.getElementById('roomCodeInput'),
  nameInput: document.getElementById('nameInput'),
  currentRoom: document.getElementById('currentRoom'),
  localVideo: document.getElementById('localVideo'),
  videoGrid: document.getElementById('videoGrid'),
  toggleMic: document.getElementById('toggleMic'),
  toggleCam: document.getElementById('toggleCam'),
  shareScreen: document.getElementById('shareScreen'),
  leaveBtn: document.getElementById('leaveBtn'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendChat: document.getElementById('sendChat')
};

// Helpers
function addMessage({ user, text, at }) {
  const div = document.createElement('div');
  div.className = 'msg';
  const time = new Date(at).toLocaleTimeString();
  div.innerHTML = `<div class="meta">${user} • ${time}</div><div>${text}</div>`;
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function createVideoEl(peerId, labelText) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.id = `card-${peerId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.id = `video-${peerId}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = labelText || peerId;

  card.appendChild(video);
  card.appendChild(label);
  els.videoGrid.appendChild(card);
  return video;
}

function removeVideoEl(peerId) {
  const card = document.getElementById(`card-${peerId}`);
  if (card) card.remove();
}

// Media setup
async function initLocalMedia() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  els.localVideo.srcObject = localStream;
  return localStream;
}

// Peer connection setup
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    let video = document.getElementById(`video-${peerId}`);
    if (!video) video = createVideoEl(peerId, `Peer ${peerId.slice(0,4)}`);
    video.srcObject = stream;
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'failed' || state === 'disconnected') {
      removeVideoEl(peerId);
    }
  };

  peers.set(peerId, pc);
  return pc;
}

async function makeOffer(toPeerId) {
  const pc = peers.get(toPeerId) || createPeerConnection(toPeerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: toPeerId, signal: offer });
}

async function handleSignal({ from, signal }) {
  const pc = peers.get(from) || createPeerConnection(from);

  if (signal.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, signal: answer });
  } else if (signal.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal));
  } else if (signal.candidate) {
    // Some implementations send candidates via signal; we handle ICE separately too
    try {
      await pc.addIceCandidate(signal.candidate);
    } catch (err) {
      console.warn('Error adding ICE candidate via signal:', err);
    }
  }
}

// Screen sharing
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];

    // Replace video track in each peer connection
    for (const [peerId, pc] of peers.entries()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    }

    // Show locally
    els.localVideo.srcObject = screenStream;

    screenTrack.onended = () => {
      stopScreenShare();
    };
  } catch (e) {
    console.error('Screen share error:', e);
  }
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  const camTrack = localStream.getVideoTracks()[0];
  for (const [peerId, pc] of peers.entries()) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(camTrack);
  }
  els.localVideo.srcObject = localStream;
}

// UI bindings
els.createBtn.onclick = async () => {
  const { roomId } = await new Promise(resolve => socket.emit('create-room', resolve));
  currentRoomId = roomId;
  userName = els.nameInput.value.trim() || `Guest-${String(Math.random()).slice(2, 6)}`;
  els.currentRoom.textContent = `Room: ${roomId}`;
  await initLocalMedia();
};

els.joinBtn.onclick = async () => {
  const roomId = els.roomCodeInput.value.trim();
  if (!roomId) { alert('Enter a room code'); return; }
  await initLocalMedia();

  userName = els.nameInput.value.trim() || `Guest-${String(Math.random()).slice(2, 6)}`;
  socket.emit('join-room', { roomId, userName }, (res) => {
    if (!res.ok) {
      alert(res.error || 'Join failed');
      return;
    }
    currentRoomId = roomId;
    els.currentRoom.textContent = `Room: ${roomId}`;
  });
};

els.toggleMic.onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.toggleMic.querySelector('.ctl-label').textContent = track.enabled ? 'Mute' : 'Unmute';
};

els.toggleCam.onclick = async () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.toggleCam.querySelector('.ctl-label').textContent = track.enabled ? 'Camera Off' : 'Camera On';
};

els.shareScreen.onclick = async () => {
  if (screenStream) {
    stopScreenShare();
    els.shareScreen.querySelector('.ctl-label').textContent = 'Share screen';
  } else {
    await startScreenShare();
    els.shareScreen.querySelector('.ctl-label').textContent = 'Stop sharing';
  }
};

els.leaveBtn.onclick = () => {
  if (!currentRoomId) return;
  socket.emit('leave-room', { roomId: currentRoomId });
  for (const [peerId, pc] of peers.entries()) {
    pc.close();
    removeVideoEl(peerId);
  }
  peers.clear();
  currentRoomId = null;
  els.currentRoom.textContent = '';
  if (screenStream) stopScreenShare();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  els.localVideo.srcObject = null;
};

// Chat
els.sendChat.onclick = () => {
  const text = els.chatInput.value.trim();
  if (!text || !currentRoomId) return;
  socket.emit('chat-message', { roomId: currentRoomId, text });
  els.chatInput.value = '';
};
els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.sendChat.click();
});

// Socket events
socket.on('participants', (ids) => {
  // Make offers to all existing participants except ourselves
  ids.filter(id => id !== socket.id).forEach(id => makeOffer(id));
});

socket.on('user-joined', ({ id, name }) => {
  // Create placeholder for their video; offer will be made via participants or here
  createVideoEl(id, name || `Peer ${id.slice(0,4)}`);
  makeOffer(id);
});

socket.on('user-left', (id) => {
  const pc = peers.get(id);
  if (pc) pc.close();
  peers.delete(id);
  removeVideoEl(id);
});

socket.on('signal', async (data) => {
  await handleSignal(data);
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = peers.get(from) || createPeerConnection(from);
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn('Error adding ICE candidate:', err);
  }
});

socket.on('chat-message', (msg) => {
  addMessage(msg);
});

// Auto init local media on load (optional)
// initLocalMedia();
