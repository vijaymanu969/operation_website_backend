const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/rbac');
const attendanceController = require('../controllers/attendanceController');

router.use(verifyGoTrueJWT);

router.get('/', requirePageAccess('attendance', 'view'), attendanceController.list);
router.post('/bulk', requirePageAccess('attendance', 'edit'), attendanceController.bulkUpsert);
router.put('/:id', requirePageAccess('attendance', 'edit'), attendanceController.update);
router.delete('/:id', requirePageAccess('attendance', 'edit'), attendanceController.delete);
router.get('/summary', requirePageAccess('attendance', 'view'), attendanceController.summary);
router.get('/analysis', requirePageAccess('attendance', 'view'), attendanceController.analysis);
router.get('/daily', requirePageAccess('attendance', 'view'), attendanceController.daily);
router.get('/trends', requirePageAccess('attendance', 'view'), attendanceController.trends);
router.get('/punctuality', requirePageAccess('attendance', 'view'), attendanceController.punctuality);
router.get('/comparison', requirePageAccess('attendance', 'view'), attendanceController.comparison);
router.get('/leave-patterns', requirePageAccess('attendance', 'view'), attendanceController.leavePatterns);
router.post('/import', requirePageAccess('attendance', 'edit'), attendanceController.upload.single('file'), attendanceController.importExcel);

module.exports = router;
