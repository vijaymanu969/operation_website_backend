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

module.exports = router;
