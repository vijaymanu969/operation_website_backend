require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const attendanceRoutes = require('./routes/attendance');
const taskRoutes = require('./routes/tasks');
const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/attendance', attendanceRoutes);
app.use('/tasks', taskRoutes);
app.use('/chat', chatRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Celume Ops API running on port ${PORT}`);
});
