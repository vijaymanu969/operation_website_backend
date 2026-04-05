const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const analyticsController = require('../controllers/analyticsController');

router.use(verifyGoTrueJWT);

router.get('/dashboard', requireRole('admin', 'super_admin'), analyticsController.dashboard);

module.exports = router;
