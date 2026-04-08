const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;
// Map of userId → Set of socket IDs
const userSockets = new Map();

function initSocket(httpServer) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          return cb(null, true);
        }
        return cb(new Error(`Origin ${origin} not allowed by CORS`));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Auth middleware — verify JWT on connection
  io.use((socket, next) => {
    let token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      // Fallback: read from auth_token cookie
      const cookieHeader = socket.handshake.headers?.cookie;
      if (cookieHeader) {
        const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith('auth_token='));
        if (match) token = decodeURIComponent(match.substring('auth_token='.length));
      }
    }
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, process.env.GOTRUE_JWT_SECRET);
      socket.userId = decoded.id;
      socket.userName = decoded.name;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;

    // Track user sockets
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    // Join a personal room for targeted notifications
    socket.join(`user:${userId}`);

    console.log(`Socket connected: ${socket.userName} (${userId})`);

    // Join conversation rooms when client requests
    socket.on('join_conversation', (conversationId) => {
      socket.join(`conv:${conversationId}`);
    });

    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conv:${conversationId}`);
    });

    socket.on('disconnect', () => {
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) userSockets.delete(userId);
      }
    });
  });

  return io;
}

function getIO() {
  return io;
}

// ── Emit helpers ────────────────────────────────────────────────────────────

// Emit to all members of a conversation
function emitToConversation(conversationId, event, data) {
  if (!io) return;
  io.to(`conv:${conversationId}`).emit(event, data);
}

// Emit to a specific user (all their connected sockets)
function emitToUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

// Emit to multiple users
function emitToUsers(userIds, event, data) {
  if (!io) return;
  for (const uid of userIds) {
    io.to(`user:${uid}`).emit(event, data);
  }
}

module.exports = { initSocket, getIO, emitToConversation, emitToUser, emitToUsers };
