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
app.set('trust proxy', 1); // honor X-Forwarded-Proto from nginx for req.secure
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Initialize Socket.IO
initSocket(server);

// Allowlist supports exact origins ("https://ops.conveylabs.ai") and
// wildcard ports for local dev ("http://localhost:*", "http://127.0.0.1:*").
const rawAllowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const exactAllowed = new Set();
const patternAllowed = [];
for (const entry of rawAllowed) {
  if (entry.includes('*')) {
    // Escape regex metachars, then turn `*` into `.*`
    const re = new RegExp(
      '^' + entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    patternAllowed.push(re);
  } else {
    exactAllowed.add(entry);
  }
}

function isOriginAllowed(origin) {
  if (exactAllowed.size === 0 && patternAllowed.length === 0) return true;
  if (exactAllowed.has(origin)) return true;
  return patternAllowed.some((re) => re.test(origin));
}

app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin / curl / server-to-server (no Origin header)
    if (!origin) return cb(null, true);
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.options('*', cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Request logger: method, route, IP, client (browser/postman/curl/etc.)
app.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  let client;
  if (/PostmanRuntime/i.test(ua)) client = 'Postman';
  else if (/insomnia/i.test(ua)) client = 'Insomnia';
  else if (/curl/i.test(ua)) client = 'curl';
  else if (/wget/i.test(ua)) client = 'wget';
  else if (/Mozilla|Chrome|Safari|Firefox|Edge|OPR/i.test(ua)) client = 'Browser';
  else if (!ua) client = 'Unknown';
  else client = ua.split(' ')[0];

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    '-';

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms.toFixed(1)}ms | ip=${ip} | client=${client}`
    );
  });
  next();
});

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
