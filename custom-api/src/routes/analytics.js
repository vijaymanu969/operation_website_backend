const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { getSummary } = require('../controllers/analyticsController');

router.get('/summary', verifyGoTrueJWT, getSummary);

module.exports = router;
