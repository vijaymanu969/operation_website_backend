const pool = require('../db');
const { findOrCreateDirectConversation, createTaskReviewMessage } = require('../helpers/chatHelpers');
const { emitToUsers } = require('../socket');

// ── Helpers: Types ──────────────────────────────────────────────────────────

async function fetchTaskTypes(taskId) {
  const result = await pool.query(
    `SELECT t.id, t.name, t.color
     FROM ops_task_type_assignments a
     JOIN ops_task_types t ON t.id = a.type_id
     WHERE a.task_id = $1`,
    [taskId]
  );
  return result.rows;
}

async function replaceTaskTypes(taskId, typeIds) {
  await pool.query('DELETE FROM ops_task_type_assignments WHERE task_id = $1', [taskId]);
  for (const typeId of typeIds) {
    await pool.query(
      'INSERT INTO ops_task_type_assignments (task_id, type_id) VALUES ($1, $2)',
      [taskId, typeId]
    );
  }
}

// ── Helpers: Assignees & Reviewers (junction tables) ────────────────────────

async function fetchAssignees(taskId) {
  const result = await pool.query(
    `SELECT u.id, u.name FROM ops_task_assignees a JOIN ops_users u ON u.id = a.user_id WHERE a.task_id = $1`,
    [taskId]
  );
  return result.rows;
}

async function fetchReviewers(taskId) {
  const result = await pool.query(
    `SELECT u.id, u.name FROM ops_task_reviewers r JOIN ops_users u ON u.id = r.user_id WHERE r.task_id = $1`,
    [taskId]
  );
  return result.rows;
}

async function replaceAssignees(taskId, userIds) {
  await pool.query('DELETE FROM ops_task_assignees WHERE task_id = $1', [taskId]);
  for (const uid of userIds) {
    await pool.query('INSERT INTO ops_task_assignees (task_id, user_id) VALUES ($1, $2)', [taskId, uid]);
  }
}

async function replaceReviewers(taskId, userIds) {
  await pool.query('DELETE FROM ops_task_reviewers WHERE task_id = $1', [taskId]);
  for (const uid of userIds) {
    await pool.query('INSERT INTO ops_task_reviewers (task_id, user_id) VALUES ($1, $2)', [taskId, uid]);
  }
}

async function getAssigneeIds(taskId) {
  const r = await pool.query('SELECT user_id FROM ops_task_assignees WHERE task_id = $1', [taskId]);
  return r.rows.map(row => row.user_id);
}

async function getReviewerIds(taskId) {
  const r = await pool.query('SELECT user_id FROM ops_task_reviewers WHERE task_id = $1', [taskId]);
  return r.rows.map(row => row.user_id);
}

// ── Helpers: Health & Time ──────────────────────────────────────────────────

function computeHealth(lastActivity) {
  if (!lastActivity) return { health: 'active', days_inactive: 0 };
  const now = new Date();
  const last = new Date(lastActivity);
  const days = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  let health = 'active';
  if (days >= 14) health = 'dead';
  else if (days >= 7) health = 'stagnant';
  else if (days >= 3) health = 'at_risk';
  return { health, days_inactive: days };
}

async function computeTimeMetrics(task) {
  const pauseResult = await pool.query(
    `SELECT id, paused_at, resumed_at, reason, note, paused_by,
            (SELECT name FROM ops_users WHERE id = tp.paused_by) AS paused_by_name
     FROM ops_task_pauses tp
     WHERE task_id = $1 ORDER BY paused_at ASC`,
    [task.id]
  );
  const pause_logs = pauseResult.rows;

  let paused_days = 0;
  for (const p of pause_logs) {
    const start = new Date(p.paused_at);
    const end = p.resumed_at ? new Date(p.resumed_at) : new Date();
    paused_days += Math.max(0, Math.floor((end - start) / (1000 * 60 * 60 * 24)));
  }

  let planned_days = null;
  if (task.date && task.end_date) {
    planned_days = Math.floor((new Date(task.end_date) - new Date(task.date)) / (1000 * 60 * 60 * 24));
  }

  let actual_days = null;
  let drift = null;
  if (task.completed_at && task.date) {
    actual_days = Math.floor((new Date(task.completed_at) - new Date(task.date)) / (1000 * 60 * 60 * 24)) - paused_days;
    if (planned_days !== null) {
      drift = actual_days - planned_days;
    }
  }

  return { planned_days, paused_days, actual_days, drift, pause_logs };
}

async function getLastActivity(taskId) {
  const result = await pool.query(
    `SELECT MAX(ts) AS last_activity FROM (
       SELECT MAX(created_at) AS ts FROM ops_task_pauses WHERE task_id = $1
       UNION ALL
       SELECT MAX(created_at) AS ts FROM ops_task_comments WHERE task_id = $1
       UNION ALL
       SELECT MAX(GREATEST(COALESCE(paused_at, '1970-01-01'), COALESCE(resumed_at, '1970-01-01')))::timestamptz AS ts
       FROM ops_task_pauses WHERE task_id = $1
     ) sub`,
    [taskId]
  );
  return result.rows[0]?.last_activity || null;
}

// Helper: enrich a task row with assignees, reviewers, types, metrics, health
async function enrichTask(task, opts = {}) {
  task.assignees = await fetchAssignees(task.id);
  task.reviewers = await fetchReviewers(task.id);
  task.types = await fetchTaskTypes(task.id);

  const metrics = await computeTimeMetrics(task);
  task.planned_days = metrics.planned_days;
  task.paused_days = metrics.paused_days;
  task.actual_days = metrics.actual_days;
  task.drift = metrics.drift;

  if (opts.includePauseLogs) {
    task.pause_logs = metrics.pause_logs;
  }

  if (task.status === 'not_completed') {
    const lastActivity = await getLastActivity(task.id);
    const h = computeHealth(lastActivity || task.created_at);
    task.health = h.health;
    task.days_inactive = h.days_inactive;
  }

  return task;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

async function listTasks(req, res) {
  try {
    const { status, priority, person_id, reviewer_id, column_group, type_id } = req.query;

    let query = `
      SELECT DISTINCT t.id, t.title, t.description, t.status, t.priority,
             t.date, t.end_date, t.created_by,
             t.column_group, t.sort_order, t.is_paused, t.completed_at, t.date_set_by,
             t.created_at, t.updated_at
      FROM ops_tasks t
    `;

    const conditions = [];
    const params = [];

    if (type_id) {
      query += ' JOIN ops_task_type_assignments ta ON ta.task_id = t.id';
      params.push(type_id);
      conditions.push(`ta.type_id = $${params.length}`);
    }

    if (person_id) {
      query += ' JOIN ops_task_assignees asgn ON asgn.task_id = t.id';
      params.push(person_id);
      conditions.push(`asgn.user_id = $${params.length}`);
    }

    if (reviewer_id) {
      query += ' JOIN ops_task_reviewers rev ON rev.task_id = t.id';
      params.push(reviewer_id);
      conditions.push(`rev.user_id = $${params.length}`);
    }

    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`t.priority = $${params.length}`); }
    if (column_group) { params.push(column_group); conditions.push(`t.column_group = $${params.length}`); }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY t.sort_order ASC, t.created_at DESC';

    const result = await pool.query(query, params);

    const tasks = [];
    for (const task of result.rows) {
      await enrichTask(task);
      tasks.push(task);
    }

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list tasks' });
  }
}

async function createTask(req, res) {
  try {
    const { title, description, priority, date, end_date, person_ids, reviewer_ids, column_group, type_ids,
            // backward compat: accept single person_id/reviewer_id too
            person_id, reviewer_id } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await pool.query(
      `INSERT INTO ops_tasks (title, description, priority, date, end_date, created_by, column_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        title,
        description || '',
        priority || 'medium',
        date || null,
        end_date || null,
        req.user.id,
        column_group || 'todo',
      ]
    );

    const task = result.rows[0];

    // Handle assignees: accept person_ids array or single person_id
    const assignees = Array.isArray(person_ids) ? person_ids : (person_id ? [person_id] : []);
    if (assignees.length > 0) await replaceAssignees(task.id, assignees);

    // Handle reviewers: accept reviewer_ids array or single reviewer_id
    const reviewers = Array.isArray(reviewer_ids) ? reviewer_ids : (reviewer_id ? [reviewer_id] : []);
    if (reviewers.length > 0) await replaceReviewers(task.id, reviewers);

    if (Array.isArray(type_ids) && type_ids.length > 0) {
      await replaceTaskTypes(task.id, type_ids);
    }

    await enrichTask(task);
    return res.status(201).json(task);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create task' });
  }
}

async function getTask(req, res) {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT t.id, t.title, t.description, t.status, t.priority,
              t.date, t.end_date, t.created_by,
              t.column_group, t.sort_order, t.is_paused, t.completed_at, t.date_set_by,
              t.created_at, t.updated_at
       FROM ops_tasks t
       WHERE t.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = result.rows[0];
    await enrichTask(task, { includePauseLogs: true });

    // Fetch comments
    const comments = await pool.query(
      `SELECT c.id, c.text, c.user_id, u.name AS user_name, c.created_at
       FROM ops_task_comments c
       JOIN ops_users u ON u.id = c.user_id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [id]
    );
    task.comments = comments.rows;

    return res.json(task);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch task' });
  }
}

async function updateTask(req, res) {
  try {
    const { id } = req.params;
    const { title, description, priority, date, end_date, column_group, sort_order,
            person_ids, reviewer_ids, person_id, reviewer_id, type_ids } = req.body;

    const existing = await pool.query('SELECT id FROM ops_tasks WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const fields = [];
    const params = [];

    if (title !== undefined) { params.push(title); fields.push(`title = $${params.length}`); }
    if (description !== undefined) { params.push(description); fields.push(`description = $${params.length}`); }
    if (priority !== undefined) { params.push(priority); fields.push(`priority = $${params.length}`); }
    if (date !== undefined) { params.push(date); fields.push(`date = $${params.length}`); }
    if (end_date !== undefined) { params.push(end_date); fields.push(`end_date = $${params.length}`); }
    if (column_group !== undefined) { params.push(column_group); fields.push(`column_group = $${params.length}`); }
    if (sort_order !== undefined) { params.push(sort_order); fields.push(`sort_order = $${params.length}`); }

    let task;
    if (fields.length > 0) {
      params.push(id);
      const result = await pool.query(
        `UPDATE ops_tasks SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      task = result.rows[0];
    } else {
      const r = await pool.query('SELECT * FROM ops_tasks WHERE id = $1', [id]);
      task = r.rows[0];
    }

    // Update assignees
    const assignees = Array.isArray(person_ids) ? person_ids : (person_id ? [person_id] : null);
    if (assignees) await replaceAssignees(id, assignees);

    // Update reviewers
    const reviewers = Array.isArray(reviewer_ids) ? reviewer_ids : (reviewer_id ? [reviewer_id] : null);
    if (reviewers) await replaceReviewers(id, reviewers);

    if (Array.isArray(type_ids)) {
      await replaceTaskTypes(id, type_ids);
    }

    await enrichTask(task);
    return res.json(task);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update task' });
  }
}

async function deleteTask(req, res) {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM ops_tasks WHERE id = $1 RETURNING id, title',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    return res.json({ message: 'Task deleted', task: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete task' });
  }
}

// ── Status Flow ─────────────────────────────────────────────────────────────

async function changeStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['not_completed', 'reviewer', 'completed', 'idea', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: not_completed, reviewer, completed, idea, or archived' });
    }

    const taskResult = await pool.query('SELECT id, status, created_by FROM ops_tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    const userId = req.user.id;
    const assigneeIds = await getAssigneeIds(id);
    const reviewerIds = await getReviewerIds(id);

    // REVIEWER FLOW RULES
    if (status === 'reviewer') {
      if (task.status !== 'not_completed') {
        return res.status(403).json({ error: 'Can only submit for review when status is not_completed' });
      }
      if (!assigneeIds.includes(userId) && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only an assigned person can submit for review' });
      }
    }

    if (status === 'completed') {
      if (task.status !== 'reviewer') {
        return res.status(403).json({ error: 'Can only complete a task that is in review' });
      }
      if (!reviewerIds.includes(userId) && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only a reviewer can approve this task' });
      }
    }

    if (status === 'not_completed' && task.status === 'reviewer') {
      if (!reviewerIds.includes(userId) && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only a reviewer can reject this task' });
      }
    }

    let updateQuery;
    if (status === 'completed') {
      updateQuery = await pool.query(
        'UPDATE ops_tasks SET status = $1, completed_at = CURRENT_DATE WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      updateQuery = await pool.query(
        'UPDATE ops_tasks SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
    }

    const updated = updateQuery.rows[0];

    // Chat integration: when submitted for review, create review cards for each assignee-reviewer pair
    if (status === 'reviewer' && assigneeIds.length > 0 && reviewerIds.length > 0) {
      try {
        for (const aId of assigneeIds) {
          for (const rId of reviewerIds) {
            const convId = await findOrCreateDirectConversation(aId, rId);
            await createTaskReviewMessage(convId, aId, updated.id);
          }
        }
      } catch (chatErr) {
        // Don't fail the status change if chat integration fails
      }
    }

    await enrichTask(updated);

    // Emit real-time notification for status changes
    const notifyIds = [...new Set([...assigneeIds, ...reviewerIds])].filter(id => id !== userId);
    if (notifyIds.length > 0) {
      emitToUsers(notifyIds, 'notification', {
        type: 'task_status_changed',
        task_id: id,
        task_title: updated.title,
        new_status: status,
        changed_by: req.user.name,
      });
    }

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to change status' });
  }
}

// ── Comments ────────────────────────────────────────────────────────────────

async function addComment(req, res) {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    const taskCheck = await pool.query('SELECT id FROM ops_tasks WHERE id = $1', [id]);
    if (taskCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const result = await pool.query(
      `INSERT INTO ops_task_comments (task_id, user_id, text)
       VALUES ($1, $2, $3)
       RETURNING id, task_id, user_id, text, created_at`,
      [id, req.user.id, text.trim()]
    );

    const comment = result.rows[0];
    comment.user_name = req.user.name;
    return res.status(201).json(comment);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add comment' });
  }
}

// ── Task Types CRUD ─────────────────────────────────────────────────────────

async function listTaskTypes(req, res) {
  try {
    const result = await pool.query('SELECT * FROM ops_task_types ORDER BY name');
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list task types' });
  }
}

async function createTaskType(req, res) {
  try {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      'INSERT INTO ops_task_types (name, color) VALUES ($1, $2) RETURNING *',
      [name, color || 'gray']
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create task type' });
  }
}

async function updateTaskType(req, res) {
  try {
    const { id } = req.params;
    const { name, color } = req.body;
    const fields = [];
    const params = [];
    if (name !== undefined) { params.push(name); fields.push(`name = $${params.length}`); }
    if (color !== undefined) { params.push(color); fields.push(`color = $${params.length}`); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    const result = await pool.query(
      `UPDATE ops_task_types SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task type not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update task type' });
  }
}

async function deleteTaskType(req, res) {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM ops_task_types WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task type not found' });
    return res.json({ message: 'Task type deleted', type: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete task type' });
  }
}

// ── Pause / Resume ──────────────────────────────────────────────────────────

async function pauseTask(req, res) {
  try {
    const { id } = req.params;
    const { reason, note } = req.body;

    if (!reason || !['priority_shift', 'blocked', 'need_info', 'other'].includes(reason)) {
      return res.status(400).json({ error: 'reason is required. Must be: priority_shift, blocked, need_info, or other' });
    }

    const taskResult = await pool.query('SELECT id, is_paused, title FROM ops_tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const task = taskResult.rows[0];
    if (task.is_paused) return res.status(400).json({ error: 'Task is already paused' });

    const userId = req.user.id;
    const assigneeIds = await getAssigneeIds(id);

    // Auth: any assignee, admin, or super_admin
    if (!assigneeIds.includes(userId) && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only an assigned person or admin can pause this task' });
    }

    const pauseResult = await pool.query(
      `INSERT INTO ops_task_pauses (task_id, paused_by, reason, note)
       VALUES ($1, $2, $3, $4) RETURNING id, paused_at, reason, note`,
      [id, userId, reason, note || null]
    );

    await pool.query('UPDATE ops_tasks SET is_paused = true WHERE id = $1', [id]);

    // Notify all reviewers via chat
    try {
      const reviewerIds = await getReviewerIds(id);
      const reasonText = reason.replace(/_/g, ' ');
      const msg = `⏸ Task paused: "${task.title}" — Reason: ${reasonText}${note ? '. Note: ' + note : ''}`;
      for (const rId of reviewerIds) {
        const convId = await findOrCreateDirectConversation(userId, rId);
        await pool.query(
          `INSERT INTO ops_messages (conversation_id, sender_id, type, content) VALUES ($1, $2, 'text', $3)`,
          [convId, userId, msg]
        );
      }
    } catch (chatErr) {
      // Don't fail the pause if chat notification fails
    }

    // Emit real-time notification
    const reviewerIds = await getReviewerIds(id);
    const notifyIds = [...new Set([...assigneeIds, ...reviewerIds])].filter(uid => uid !== userId);
    emitToUsers(notifyIds, 'notification', {
      type: 'task_paused',
      task_id: id,
      task_title: task.title,
      reason,
      paused_by: req.user.name,
    });

    return res.json({ message: 'Task paused', pause: pauseResult.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to pause task' });
  }
}

async function resumeTask(req, res) {
  try {
    const { id } = req.params;

    const taskResult = await pool.query('SELECT id, is_paused FROM ops_tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const task = taskResult.rows[0];
    if (!task.is_paused) return res.status(400).json({ error: 'Task is not paused' });

    const userId = req.user.id;
    const assigneeIds = await getAssigneeIds(id);

    if (!assigneeIds.includes(userId) && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only an assigned person or admin can resume this task' });
    }

    await pool.query(
      `UPDATE ops_task_pauses SET resumed_at = CURRENT_DATE WHERE task_id = $1 AND resumed_at IS NULL`,
      [id]
    );

    await pool.query('UPDATE ops_tasks SET is_paused = false WHERE id = $1', [id]);

    return res.json({ message: 'Task resumed' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to resume task' });
  }
}

// ── Time Logs ───────────────────────────────────────────────────────────────

async function getTaskTime(req, res) {
  try {
    const { id } = req.params;

    const taskResult = await pool.query(
      'SELECT id, date, end_date, completed_at, date_set_by, is_paused FROM ops_tasks WHERE id = $1',
      [id]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const task = taskResult.rows[0];
    const metrics = await computeTimeMetrics(task);

    return res.json({
      task_id: task.id,
      date: task.date,
      end_date: task.end_date,
      completed_at: task.completed_at,
      date_set_by: task.date_set_by,
      is_paused: task.is_paused,
      planned_days: metrics.planned_days,
      paused_days: metrics.paused_days,
      actual_days: metrics.actual_days,
      drift: metrics.drift,
      pause_logs: metrics.pause_logs,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get task time logs' });
  }
}

// ── Stagnant Tasks ──────────────────────────────────────────────────────────

async function stagnantTasks(req, res) {
  try {
    const { health } = req.query;

    const tasksResult = await pool.query(
      `SELECT t.id, t.title, t.status, t.created_at FROM ops_tasks t WHERE t.status = 'not_completed'`
    );

    const results = [];
    for (const task of tasksResult.rows) {
      const assignees = await fetchAssignees(task.id);
      const lastActivity = await getLastActivity(task.id);
      const h = computeHealth(lastActivity || task.created_at);

      if (h.health === 'active') continue;
      if (health && h.health !== health) continue;

      results.push({
        id: task.id,
        title: task.title,
        assignees,
        health: h.health,
        days_inactive: h.days_inactive,
        last_activity: lastActivity || task.created_at,
        status: task.status,
      });
    }

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get stagnant tasks' });
  }
}

// ── Archive ─────────────────────────────────────────────────────────────────

async function archiveTask(req, res) {
  try {
    const { id } = req.params;
    const taskResult = await pool.query('SELECT id FROM ops_tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    await pool.query("UPDATE ops_tasks SET status = 'archived' WHERE id = $1", [id]);
    return res.json({ message: 'Task archived', task_id: id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to archive task' });
  }
}

// ── Reorder ─────────────────────────────────────────────────────────────────

async function reorderTasks(req, res) {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'tasks must be a non-empty array of {id, column_group, sort_order}' });
    }
    for (const t of tasks) {
      await pool.query(
        'UPDATE ops_tasks SET column_group = $1, sort_order = $2 WHERE id = $3',
        [t.column_group, t.sort_order, t.id]
      );
    }
    return res.json({ updated: tasks.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reorder tasks' });
  }
}

module.exports = {
  listTasks, createTask, getTask, updateTask, deleteTask,
  changeStatus, addComment,
  listTaskTypes, createTaskType, updateTaskType, deleteTaskType,
  pauseTask, resumeTask, getTaskTime,
  stagnantTasks, archiveTask, reorderTasks,
};
