const Attendance = require('../models/attendance');

async function getAttendance(req, res) {
  try {
    const records = await Attendance.getByUserId(req.user.sub);
    res.json(records);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
}

async function checkIn(req, res) {
  try {
    const { notes } = req.body || {};
    const record = await Attendance.checkIn(req.user.sub, notes);
    res.status(201).json(record);
  } catch (err) {
    console.error('Error checking in:', err);
    res.status(500).json({ error: 'Failed to check in' });
  }
}

async function checkOut(req, res) {
  try {
    const record = await Attendance.checkOut(req.user.sub);
    if (!record) {
      return res.status(404).json({ error: 'No active check-in found for today' });
    }
    res.json(record);
  } catch (err) {
    console.error('Error checking out:', err);
    res.status(500).json({ error: 'Failed to check out' });
  }
}

module.exports = { getAttendance, checkIn, checkOut };
