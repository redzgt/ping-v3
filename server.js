// server.js — Ping (server-side only)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidV4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files from /public
app.use(express.static('public'));

// Keep track of rooms and participants
const rooms = new Map(); // roomId -> Set(socketId)

io.on('connection', (socket) => {
  socket.data.userName = `Guest-${String(Math.random()).slice(2, 6)}`;

  // Create a new room
  socket.on('create-room', (callback) => {
    const roomId = uuidV4().slice(0, 6); // short random code
    rooms.set(roomId, new Set());
    socket.join(roomId);
    rooms.get(roomId).add(socket.id);
    callback({ roomId });
    io.to(roomId).emit('participants', Array.from(rooms.get(roomId)));
  });

  // Join an existing room
  socket.on('join-room', ({ roomId, userName }, callback) => {
    if (!rooms.has(roomId)) {
      callback({ ok: false, error: 'Room not found' });
      return;
    }
    socket.data.userName = userName || socket.data.userName;
    socket.join(roomId);
    rooms.get(roomId).add(socket.id);
    callback({ ok: true });

    // Notify others
    socket.to(roomId).emit('user-joined', { id: socket.id, name: socket.data.userName });

    // Send current participants to new joiner
    io.to(socket.id).emit('participants', Array.from(rooms.get(roomId)));
  });

  // WebRTC signaling
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // ICE candidates
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Chat
  socket.on('chat-message', ({ roomId, text }) => {
    const name = socket.data.userName || 'Guest';
    io.to(roomId).emit('chat-message', { user: name, text, at: Date.now() });
  });

  // Leaving a room
  socket.on('leave-room', ({ roomId }) => {
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(socket.id);
      socket.leave(roomId);
      socket.to(roomId).emit('user-left', socket.id);
      if (rooms.get(roomId).size === 0) rooms.delete(roomId);
    }
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    for (const [roomId, set] of rooms.entries()) {
      if (set.delete(socket.id)) {
        socket.to(roomId).emit('user-left', socket.id);
        if (set.size === 0) rooms.delete(roomId);
      }
    }
  });
});

// Render requires binding to process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ping server running on port ${PORT}`));
