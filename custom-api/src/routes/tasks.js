const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/rbac');
const taskController = require('../controllers/taskController');

router.use(verifyGoTrueJWT);

// Task types (must be before /:id to avoid route conflicts)
router.get('/types', taskController.listTaskTypes);
router.post('/types', requirePageAccess('tasks', 'edit'), taskController.createTaskType);
router.put('/types/:id', requirePageAccess('tasks', 'edit'), taskController.updateTaskType);
router.delete('/types/:id', requirePageAccess('tasks', 'edit'), taskController.deleteTaskType);

// Tasks CRUD
router.get('/', requirePageAccess('tasks', 'view'), taskController.listTasks);
router.post('/', requirePageAccess('tasks', 'edit'), taskController.createTask);
router.get('/:id', requirePageAccess('tasks', 'view'), taskController.getTask);
router.put('/:id', requirePageAccess('tasks', 'edit'), taskController.updateTask);
router.delete('/:id', requirePageAccess('tasks', 'edit'), taskController.deleteTask);
router.put('/:id/status', requirePageAccess('tasks', 'view'), taskController.changeStatus);
router.post('/:id/comments', requirePageAccess('tasks', 'view'), taskController.addComment);

module.exports = router;
