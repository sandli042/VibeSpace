const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, 'index.html');
// All room state lives in memory by design. Restarting the process resets rooms, chat, and queues.
const rooms = new Map();
const roomCleanupTimers = new Map();
const ROOM_REFRESH_GRACE_MS = 15000;

function createRoom(roomId) {
  return {
    id: roomId,
    hostSocketId: null,
    users: new Map(),
    chat: [],
    queue: [],
    currentItem: null,
    playback: {
      status: 'paused',
      positionMs: 0,
      updatedAt: Date.now(),
      startedAt: null,
      lastActionId: null,
    },
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
  return rooms.get(roomId);
}

function cancelRoomCleanup(roomId) {
  const timer = roomCleanupTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    roomCleanupTimers.delete(roomId);
  }
}

function sanitizeText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 80) : fallback;
}

function sanitizeChatText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 300);
}

function normalizeRoomId(value) {
  const roomId = sanitizeText(value, 'lobby').toLowerCase();
  return roomId.replace(/[^a-z0-9-_]/g, '').slice(0, 32) || 'lobby';
}

function normalizePlaybackPosition(positionMs) {
  const parsed = Number(positionMs);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function parseMediaUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  try {
    const url = new URL(rawUrl.trim());
    const host = url.hostname.toLowerCase();

    if (host.includes('youtube.com') || host.includes('youtube-nocookie.com') || host.includes('youtu.be')) {
      let videoId = '';
      if (host.includes('youtu.be')) videoId = url.pathname.split('/').filter(Boolean)[0] || '';
      else if (url.searchParams.get('v')) videoId = url.searchParams.get('v');
      else if (url.pathname.includes('/embed/')) videoId = url.pathname.split('/embed/')[1]?.split('/')[0] || '';
      else if (url.pathname.includes('/shorts/')) videoId = url.pathname.split('/shorts/')[1]?.split('/')[0] || '';

      videoId = videoId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      if (!videoId) return null;

      return {
        id: `yt_${videoId}_${Date.now()}`,
        type: 'youtube',
        url: rawUrl.trim(),
        sourceId: videoId,
        title: `YouTube: ${videoId}`,
      };
    }

    const extension = path.extname(url.pathname).toLowerCase();
    if (new Set(['.mp4', '.webm', '.ogg', '.m4v']).has(extension)) {
      const fileName = decodeURIComponent(url.pathname.split('/').pop() || 'Video');
      return {
        id: `mp4_${Date.now()}`,
        type: 'mp4',
        url: rawUrl.trim(),
        sourceId: rawUrl.trim(),
        title: `Video: ${fileName}`,
      };
    }

    // Treat any other URL as a website
    const title = url.hostname || 'Website';
    return {
      id: `website_${Date.now()}`,
      type: 'website',
      url: rawUrl.trim(),
      sourceId: rawUrl.trim(),
      title: `Website: ${title}`,
    };
  } catch (_) {
    return null;
  }

  return null;
}

function getEffectivePlayback(room) {
  const playback = room.playback;
  if (playback.status !== 'playing' || !playback.startedAt) return { ...playback };

  return {
    ...playback,
    positionMs: Math.max(0, playback.positionMs + (Date.now() - playback.startedAt)),
    updatedAt: Date.now(),
  };
}

function serializeRoom(room) {
  return {
    roomId: room.id,
    hostSocketId: room.hostSocketId,
    users: Array.from(room.users.values()).map((user) => ({ socketId: user.socketId, name: user.name })),
    queue: room.queue,
    currentItem: room.currentItem,
    playback: getEffectivePlayback(room),
    chat: room.chat.slice(-50),
  };
}

function assignHost(room) {
  if (room.hostSocketId && room.users.has(room.hostSocketId)) return room.hostSocketId;
  room.hostSocketId = room.users.keys().next().value || null;
  return room.hostSocketId;
}

function broadcastRoomState(io, room) {
  io.to(room.id).emit('room:state', serializeRoom(room));
}

function pushChatMessage(room, message) {
  room.chat.push(message);
  if (room.chat.length > 100) room.chat.shift();
}

function updatePlaybackFromAction(room, action) {
  const now = Date.now();
  room.playback.status = action.type === 'play' ? 'playing' : 'paused';
  room.playback.positionMs = normalizePlaybackPosition(action.positionMs);
  room.playback.updatedAt = now;
  room.playback.startedAt = room.playback.status === 'playing' ? now : null;
  room.playback.lastActionId = action.actionId || `action_${now}`;
}

function advanceQueue(room) {
  room.currentItem = room.queue.shift() || null;
  room.playback = {
    status: 'paused',
    positionMs: 0,
    updatedAt: Date.now(),
    startedAt: null,
    lastActionId: `load_${Date.now()}`,
  };
}

function maybeCleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    cancelRoomCleanup(roomId);
    return;
  }

  if (room.users.size > 0) {
    cancelRoomCleanup(roomId);
    return;
  }

  if (roomCleanupTimers.has(roomId)) return;

  const timer = setTimeout(() => {
    roomCleanupTimers.delete(roomId);
    const latestRoom = rooms.get(roomId);
    if (latestRoom && latestRoom.users.size === 0) rooms.delete(roomId);
  }, ROOM_REFRESH_GRACE_MS);

  roomCleanupTimers.set(roomId, timer);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  if (req.url === '/' || req.url.startsWith('/?')) {
    fs.createReadStream(INDEX_PATH)
      .on('open', () => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }))
      .on('error', () => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unable to load index.html');
      })
      .pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('room:join', (payload = {}, callback = () => {}) => {
    const roomId = normalizeRoomId(payload.roomId);
    const userName = sanitizeText(payload.userName, 'Guest');
    cancelRoomCleanup(roomId);
    const room = getRoom(roomId);

    currentRoomId = roomId;
    socket.join(roomId);
    room.users.set(socket.id, { socketId: socket.id, name: userName, joinedAt: Date.now() });

    const hostSocketId = assignHost(room);
    const joinedMessage = {
      id: `msg_${Date.now()}_${socket.id}`,
      type: 'system',
      userName: 'System',
      text: `${userName} joined the room.`,
      timestamp: Date.now(),
    };

    pushChatMessage(room, joinedMessage);
    broadcastRoomState(io, room);
    socket.to(roomId).emit('chat:new', joinedMessage);
    io.to(roomId).emit('host:changed', { hostSocketId });

    callback({ ok: true, room: serializeRoom(room), selfSocketId: socket.id });
  });

  socket.on('chat:send', (payload = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const user = room?.users.get(socket.id);
    if (!room || !user) return;

    const text = sanitizeChatText(payload.text);
    if (!text) return;

    const message = {
      id: `msg_${Date.now()}_${socket.id}`,
      type: 'user',
      userName: user.name,
      socketId: socket.id,
      text,
      timestamp: Date.now(),
    };

    pushChatMessage(room, message);
    io.to(currentRoomId).emit('chat:new', message);
  });

  socket.on('queue:add', (payload = {}, callback = () => {}) => {
    if (!currentRoomId) return callback({ ok: false, error: 'Room not joined.' });

    const room = rooms.get(currentRoomId);
    const user = room?.users.get(socket.id);
    if (!room || !user) return callback({ ok: false, error: 'User not in room.' });

    const media = parseMediaUrl(payload.url);
    if (!media) return callback({ ok: false, error: 'Invalid URL provided.' });

    room.queue.push({ ...media, addedBy: user.name, addedBySocketId: socket.id, addedAt: Date.now() });

    if (!room.currentItem) {
      advanceQueue(room);
      io.to(currentRoomId).emit('media:load', {
        currentItem: room.currentItem,
        playback: room.playback,
        queue: room.queue,
        serverTs: Date.now(),
      });
    }

    broadcastRoomState(io, room);
    callback({ ok: true, queue: room.queue, currentItem: room.currentItem });
  });

  socket.on('queue:next', (callback = () => {}) => {
    if (!currentRoomId) return callback({ ok: false, error: 'Room not joined.' });
    const room = rooms.get(currentRoomId);
    if (!room) return callback({ ok: false, error: 'Room missing.' });
    if (room.hostSocketId !== socket.id) return callback({ ok: false, error: 'Only the host can skip media.' });

    advanceQueue(room);
    io.to(currentRoomId).emit('media:load', {
      currentItem: room.currentItem,
      playback: room.playback,
      queue: room.queue,
      serverTs: Date.now(),
    });
    broadcastRoomState(io, room);
    callback({ ok: true });
  });

  socket.on('sync:action', (payload = {}, callback = () => {}) => {
    if (!currentRoomId) return callback({ ok: false, error: 'Room not joined.' });
    const room = rooms.get(currentRoomId);
    if (!room) return callback({ ok: false, error: 'Room missing.' });
    if (room.hostSocketId !== socket.id) return callback({ ok: false, error: 'Only the host can control playback.' });

    const actionType = payload.type;
    if (!new Set(['play', 'pause', 'seek', 'heartbeat', 'ended']).has(actionType)) {
      return callback({ ok: false, error: 'Unsupported sync action.' });
    }

    const now = Date.now();

    if (actionType === 'ended') {
      advanceQueue(room);
      io.to(currentRoomId).emit('media:load', {
        currentItem: room.currentItem,
        playback: room.playback,
        queue: room.queue,
        serverTs: now,
      });
      broadcastRoomState(io, room);
      return callback({ ok: true });
    }

    // Heartbeats let the host periodically refresh the authoritative timeline so viewers can correct drift.
    if (actionType === 'heartbeat') {
      room.playback.positionMs = normalizePlaybackPosition(payload.positionMs);
      room.playback.updatedAt = now;
      room.playback.startedAt = room.playback.status === 'playing' ? now : null;
      room.playback.lastActionId = payload.actionId || `heartbeat_${now}`;

      socket.to(currentRoomId).emit('sync:action', {
        type: 'heartbeat',
        positionMs: room.playback.positionMs,
        status: room.playback.status,
        serverTs: now,
        actionId: room.playback.lastActionId,
      });
      return callback({ ok: true });
    }

    // Seek is broadcast with a server timestamp so every client can land on the same shared position.
    if (actionType === 'seek') {
      room.playback.positionMs = normalizePlaybackPosition(payload.positionMs);
      room.playback.updatedAt = now;
      room.playback.startedAt = room.playback.status === 'playing' ? now : null;
      room.playback.lastActionId = payload.actionId || `seek_${now}`;

      io.to(currentRoomId).emit('sync:action', {
        type: 'seek',
        positionMs: room.playback.positionMs,
        status: room.playback.status,
        serverTs: now,
        actionId: room.playback.lastActionId,
      });
      return callback({ ok: true });
    }

    updatePlaybackFromAction(room, payload);
    io.to(currentRoomId).emit('sync:action', {
      type: actionType,
      positionMs: room.playback.positionMs,
      status: room.playback.status,
      serverTs: now,
      actionId: room.playback.lastActionId,
    });
    broadcastRoomState(io, room);
    callback({ ok: true });
  });

  socket.on('webrtc:offer', ({ targetSocketId, sdp }) => {
    if (currentRoomId && targetSocketId && sdp) io.to(targetSocketId).emit('webrtc:offer', { fromSocketId: socket.id, sdp });
  });

  socket.on('webrtc:answer', ({ targetSocketId, sdp }) => {
    if (currentRoomId && targetSocketId && sdp) io.to(targetSocketId).emit('webrtc:answer', { fromSocketId: socket.id, sdp });
  });

  socket.on('webrtc:ice-candidate', ({ targetSocketId, candidate }) => {
    if (currentRoomId && targetSocketId && candidate) {
      io.to(targetSocketId).emit('webrtc:ice-candidate', { fromSocketId: socket.id, candidate });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const departingUser = room.users.get(socket.id);
    room.users.delete(socket.id);
    const nextHost = assignHost(room);

    io.to(currentRoomId).emit('peer:left', { socketId: socket.id });

    if (departingUser) {
      const message = {
        id: `msg_${Date.now()}_${socket.id}`,
        type: 'system',
        userName: 'System',
        text: `${departingUser.name} left the room.`,
        timestamp: Date.now(),
      };
      pushChatMessage(room, message);
      io.to(currentRoomId).emit('chat:new', message);
    }

    io.to(currentRoomId).emit('host:changed', { hostSocketId: nextHost });
    broadcastRoomState(io, room);
    maybeCleanupRoom(currentRoomId);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
