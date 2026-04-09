const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const chatController = require('../controllers/chatController');

router.use(verifyGoTrueJWT);

router.get('/conversations', requireRole('admin', 'worker', 'intern', 'super_admin'), chatController.listConversations);
router.post('/conversations', requireRole('admin', 'worker', 'intern', 'super_admin'), chatController.createConversation);
router.get('/conversations/:id/messages', requireRole('admin', 'worker', 'intern', 'super_admin'), chatController.getMessages);
router.post('/conversations/:id/messages', requireRole('admin', 'worker', 'intern', 'super_admin'), chatController.sendMessage);
router.put('/messages/:id/review', requireRole('admin', 'worker', 'intern', 'super_admin'), chatController.reviewTask);

module.exports = router;
