const express = require('express');
const router = express.Router();
const { verifyGoTrueJWT } = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/rbac');
const taskController = require('../controllers/taskController');
const ideaController = require('../controllers/ideaController');
const { requireRole } = require('../middleware/rbac');

router.use(verifyGoTrueJWT);

// Task types (must be before /:id to avoid route conflicts)
router.get('/types', taskController.listTaskTypes);
router.post('/types', requirePageAccess('tasks', 'edit'), taskController.createTaskType);
router.put('/types/:id', requirePageAccess('tasks', 'edit'), taskController.updateTaskType);
router.delete('/types/:id', requirePageAccess('tasks', 'edit'), taskController.deleteTaskType);

// Stagnant tasks (before /:id to avoid route conflict)
router.get('/stagnant', requireRole('admin', 'super_admin'), taskController.stagnantTasks);

// Reorder tasks
router.put('/reorder', requirePageAccess('tasks', 'edit'), taskController.reorderTasks);

// Tasks CRUD
router.get('/', requirePageAccess('tasks', 'view'), taskController.listTasks);
router.post('/', requirePageAccess('tasks', 'edit'), taskController.createTask);
router.get('/:id', requirePageAccess('tasks', 'view'), taskController.getTask);
router.put('/:id', requirePageAccess('tasks', 'edit'), taskController.updateTask);
router.delete('/', requirePageAccess('tasks', 'edit'), taskController.bulkDeleteTasks);
router.delete('/:id', requirePageAccess('tasks', 'edit'), taskController.deleteTask);
router.put('/:id/status', requirePageAccess('tasks', 'view'), taskController.changeStatus);
router.get('/:id/comments', requirePageAccess('tasks', 'view'), taskController.listComments);
router.post('/:id/comments', requirePageAccess('tasks', 'view'), taskController.addComment);

// Pause / Resume / Time
router.put('/:id/pause', requirePageAccess('tasks', 'view'), taskController.pauseTask);
router.put('/:id/resume', requirePageAccess('tasks', 'view'), taskController.resumeTask);
router.get('/:id/time', requirePageAccess('tasks', 'view'), taskController.getTaskTime);

// Pause requests (reviewer approval flow)
router.get('/pause-requests', requirePageAccess('tasks', 'view'), taskController.listPauseRequests);
router.put('/pause-requests/:id', requirePageAccess('tasks', 'view'), taskController.approvePauseRequest);

// Archive
router.put('/:id/archive', requireRole('admin', 'super_admin'), taskController.archiveTask);

// Idea requests on a task
router.post('/:id/idea-request', requirePageAccess('tasks', 'view'), ideaController.requestIdeaMove);

module.exports = router;
