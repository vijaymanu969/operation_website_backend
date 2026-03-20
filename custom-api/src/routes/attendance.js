const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { getAttendance, checkIn, checkOut } = require('../controllers/attendanceController');

router.get('/', verifyGoTrueJWT, getAttendance);
router.post('/checkin', verifyGoTrueJWT, checkIn);
router.post('/checkout', verifyGoTrueJWT, checkOut);

module.exports = router;
