const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/rbac');
const chatController = require('../controllers/chatController');

router.use(verifyGoTrueJWT);

router.get('/conversations', requirePageAccess('chat', 'view'), chatController.listConversations);
router.post('/conversations', requirePageAccess('chat', 'view'), chatController.createConversation);
router.get('/conversations/:id/messages', requirePageAccess('chat', 'view'), chatController.getMessages);
router.post('/conversations/:id/messages', requirePageAccess('chat', 'view'), chatController.sendMessage);
router.put('/messages/:id/review', requirePageAccess('chat', 'view'), chatController.reviewTask);

module.exports = router;
