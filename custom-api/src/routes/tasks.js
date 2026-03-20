const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { getReviewQueue, submitTask, approveTask, rejectTask } = require('../controllers/taskController');

router.get('/review-queue', verifyGoTrueJWT, getReviewQueue);
router.post('/:id/submit', verifyGoTrueJWT, submitTask);
router.post('/:id/approve', verifyGoTrueJWT, approveTask);
router.post('/:id/reject', verifyGoTrueJWT, rejectTask);

module.exports = router;
