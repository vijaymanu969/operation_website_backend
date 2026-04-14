const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requirePageAccess, requireRole } = require('../middleware/rbac');
const attendanceController = require('../controllers/attendanceController');

router.use(verifyGoTrueJWT);

const ATTENDANCE_ROLES = ['admin', 'worker', 'intern', 'super_admin'];

// Reads — require at least 'view' on attendance page
router.get('/', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.list);
router.get('/summary', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.summary);
router.get('/analysis', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.analysis);
router.get('/daily', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.daily);
router.get('/trends', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.trends);
router.get('/punctuality', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.punctuality);
router.get('/comparison', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.comparison);
router.get('/leave-patterns', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'view'), attendanceController.leavePatterns);

// Writes — require 'edit' on attendance page
router.post('/bulk', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'edit'), attendanceController.bulkUpsert);
router.delete('/by-date', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'edit'), attendanceController.deleteByDate);
router.put('/:id', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'edit'), attendanceController.update);
router.delete('/:id', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'edit'), attendanceController.delete);
router.post('/import', requireRole(...ATTENDANCE_ROLES), requirePageAccess('attendance', 'edit'), attendanceController.upload.single('file'), attendanceController.importExcel);

module.exports = router;
