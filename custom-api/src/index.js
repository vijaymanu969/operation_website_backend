const express = require('express');
const cors = require('cors');

const attendanceRoutes = require('./routes/attendance');
const taskRoutes = require('./routes/tasks');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/attendance', attendanceRoutes);
app.use('/tasks', taskRoutes);
app.use('/analytics', analyticsRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Custom API running on port ${PORT}`);
});
