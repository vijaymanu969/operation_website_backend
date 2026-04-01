const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const userController = require('../controllers/userController');

router.use(verifyGoTrueJWT);

router.get('/', requireRole('super_admin', 'admin'), userController.listUsers);
router.post('/', requireRole('super_admin', 'admin'), userController.createUser);
router.get('/:id', requireRole('super_admin', 'admin'), userController.getUser);
router.put('/:id', requireRole('super_admin', 'admin'), userController.updateUser);
router.delete('/:id', requireRole('super_admin'), userController.deleteUser);
router.get('/:id/access', requireRole('super_admin', 'admin'), userController.getAccess);
router.put('/:id/access', requireRole('super_admin', 'admin'), userController.setAccess);

module.exports = router;
