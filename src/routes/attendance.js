const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requirePageAccess, requireRole } = require('../middleware/rbac');
const attendanceController = require('../controllers/attendanceController');

router.use(verifyGoTrueJWT);

router.get('/', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.list);
router.post('/bulk', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.bulkUpsert);
router.put('/:id', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.update);
router.delete('/:id', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.delete);
router.get('/summary', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.summary);
router.get('/analysis', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.analysis);
router.get('/daily', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.daily);
router.get('/trends', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.trends);
router.get('/punctuality', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.punctuality);
router.get('/comparison', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.comparison);
router.get('/leave-patterns', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.leavePatterns);
router.post('/import', requireRole('admin', 'worker', 'intern', 'super_admin'), attendanceController.upload.single('file'), attendanceController.importExcel);

module.exports = router;
