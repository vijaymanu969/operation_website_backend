const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const authController = require('../controllers/authController');

router.post('/login', authController.login);
router.get('/me', verifyGoTrueJWT, authController.getMe);
router.put('/change-password', verifyGoTrueJWT, authController.changePassword);

module.exports = router;
