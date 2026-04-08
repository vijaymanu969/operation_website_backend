require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const http = require('http');
const { initSocket } = require('./socket');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const attendanceRoutes = require('./routes/attendance');
const taskRoutes = require('./routes/tasks');
const chatRoutes = require('./routes/chat');
const ideaRequestRoutes = require('./routes/ideaRequests');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Initialize Socket.IO
initSocket(server);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin / curl / server-to-server (no Origin header)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.options('*', cors());
app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/attendance', attendanceRoutes);
app.use('/tasks', taskRoutes);
app.use('/chat', chatRoutes);
app.use('/idea-requests', ideaRequestRoutes);
app.use('/analytics', analyticsRoutes);

app.get('/', (req, res) => {
  res.send('server runing');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

server.listen(PORT, () => {
  console.log(`Celume Ops API running on port ${PORT} (HTTP + WebSocket)`);
});
