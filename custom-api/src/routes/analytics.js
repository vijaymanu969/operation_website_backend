const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const analyticsController = require('../controllers/analyticsController');

router.use(verifyGoTrueJWT);

router.get('/dashboard', requireRole('admin', 'super_admin'), analyticsController.dashboard);
router.get('/tasks/performance', requireRole('admin', 'super_admin'), analyticsController.taskPerformance);
router.get('/users/:id/summary', analyticsController.userSummary);

module.exports = router;
