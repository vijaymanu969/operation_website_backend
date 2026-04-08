const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const ideaController = require('../controllers/ideaController');

router.use(verifyGoTrueJWT);

router.get('/', requireRole('admin', 'super_admin'), ideaController.listIdeaRequests);
router.put('/:id', ideaController.reviewIdeaRequest);

module.exports = router;
