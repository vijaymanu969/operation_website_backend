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
    `SELECT u.id, u.name, u.color FROM ops_task_assignees a JOIN ops_users u ON u.id = a.user_id WHERE a.task_id = $1`,
    [taskId]
  );
  return result.rows;
}

async function fetchReviewers(taskId) {
  const result = await pool.query(
    `SELECT u.id, u.name, u.color FROM ops_task_reviewers r JOIN ops_users u ON u.id = r.user_id WHERE r.task_id = $1`,
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

  // Attach pending pause request if one exists
  const pauseReqResult = await pool.query(
    `SELECT pr.id, pr.reason, pr.note, pr.created_at, u.name AS requested_by_name, pr.requested_by
     FROM ops_task_pause_requests pr
     JOIN ops_users u ON u.id = pr.requested_by
     WHERE pr.task_id = $1 AND pr.status = 'pending'
     LIMIT 1`,
    [task.id]
  );
  task.pending_pause_request = pauseReqResult.rows[0] || null;

  return task;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

// Normalize a query param into an array of non-empty strings.
// Accepts: undefined, single string, comma-separated string, or array (?foo=a&foo=b).
function toArray(val) {
  if (val === undefined || val === null || val === '') return [];
  if (Array.isArray(val)) {
    return val.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  }
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

async function listTasks(req, res) {
  try {
    const {
      status, priority, person_id, reviewer_id, column_group, type_id, health,
      person_ids, reviewer_ids, type_ids, statuses, priorities, column_groups, healths,
      date_from, date_to,
      created_by, created_bys,
      match = 'any', // 'any' (OR) | 'all' (AND) — applies to person/reviewer/type multi-filters
    } = req.query;

    // Merge singular + plural variants into arrays
    const personIds   = [...toArray(person_id),   ...toArray(person_ids)];
    const reviewerIds = [...toArray(reviewer_id), ...toArray(reviewer_ids)];
    const typeIds     = [...toArray(type_id),     ...toArray(type_ids)];
    const statusList   = [...toArray(status),   ...toArray(statuses)];
    const priorityList = [...toArray(priority), ...toArray(priorities)];
    const columnList   = [...toArray(column_group), ...toArray(column_groups)];
    const healthList   = [...toArray(health),   ...toArray(healths)];
    const createdByList = [...toArray(created_by), ...toArray(created_bys)];

    const useAll = String(match).toLowerCase() === 'all';

    let query = `
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.date, t.end_date, t.created_by,
             t.column_group, t.sort_order, t.is_paused, t.completed_at, t.date_set_by,
             t.created_at, t.updated_at
      FROM ops_tasks t
    `;

    const conditions = [];
    const params = [];

    // Only admins see every task; workers/interns see only their assigned/reviewing tasks
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    if (!isAdmin) {
      params.push(req.user.id);
      conditions.push(`(
        EXISTS (SELECT 1 FROM ops_task_assignees WHERE task_id = t.id AND user_id = $${params.length})
        OR EXISTS (SELECT 1 FROM ops_task_reviewers WHERE task_id = t.id AND user_id = $${params.length})
      )`);
    }

    // Multi-value person filter via EXISTS + ANY (avoids duplicate rows, no DISTINCT needed)
    if (personIds.length > 0) {
      if (useAll) {
        // Task must have ALL listed people as assignees
        for (const pid of personIds) {
          params.push(pid);
          conditions.push(`EXISTS (SELECT 1 FROM ops_task_assignees WHERE task_id = t.id AND user_id = $${params.length})`);
        }
      } else {
        params.push(personIds);
        conditions.push(`EXISTS (SELECT 1 FROM ops_task_assignees WHERE task_id = t.id AND user_id = ANY($${params.length}::uuid[]))`);
      }
    }

    if (reviewerIds.length > 0) {
      if (useAll) {
        for (const rid of reviewerIds) {
          params.push(rid);
          conditions.push(`EXISTS (SELECT 1 FROM ops_task_reviewers WHERE task_id = t.id AND user_id = $${params.length})`);
        }
      } else {
        params.push(reviewerIds);
        conditions.push(`EXISTS (SELECT 1 FROM ops_task_reviewers WHERE task_id = t.id AND user_id = ANY($${params.length}::uuid[]))`);
      }
    }

    if (typeIds.length > 0) {
      if (useAll) {
        for (const tid of typeIds) {
          params.push(tid);
          conditions.push(`EXISTS (SELECT 1 FROM ops_task_type_assignments WHERE task_id = t.id AND type_id = $${params.length})`);
        }
      } else {
        params.push(typeIds);
        conditions.push(`EXISTS (SELECT 1 FROM ops_task_type_assignments WHERE task_id = t.id AND type_id = ANY($${params.length}::uuid[]))`);
      }
    }

    // Simple column filters — multi-value becomes OR (IN list)
    if (statusList.length > 0)   { params.push(statusList);   conditions.push(`t.status = ANY($${params.length}::text[])`); }
    if (priorityList.length > 0) { params.push(priorityList); conditions.push(`t.priority = ANY($${params.length}::text[])`); }
    if (columnList.length > 0)   { params.push(columnList);   conditions.push(`t.column_group = ANY($${params.length}::text[])`); }
    if (createdByList.length > 0){ params.push(createdByList);conditions.push(`t.created_by = ANY($${params.length}::uuid[])`); }

    // Date range filter
    if (date_from) { params.push(date_from); conditions.push(`t.date >= $${params.length}`); }
    if (date_to)   { params.push(date_to);   conditions.push(`t.date <= $${params.length}`); }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY t.sort_order ASC, t.created_at DESC';

    const result = await pool.query(query, params);

    const tasks = [];
    for (const task of result.rows) {
      await enrichTask(task);
      // Health filter is post-enrichment since health is computed, not stored
      if (healthList.length > 0 && !healthList.includes(task.health)) continue;
      tasks.push(task);
    }

    return res.json(tasks);
  } catch (err) {
    console.error('listTasks error:', err);
    return res.status(500).json({ error: 'Failed to list tasks', detail: err.message });
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
    if (reviewers.length === 0) {
      await pool.query('DELETE FROM ops_tasks WHERE id = $1', [task.id]);
      return res.status(400).json({ error: 'At least one reviewer (captain) is required' });
    }
    await replaceReviewers(task.id, reviewers);

    if (Array.isArray(type_ids) && type_ids.length > 0) {
      await replaceTaskTypes(task.id, type_ids);
    }

    await enrichTask(task);
    return res.status(201).json(task);
  } catch (err) {
    console.error('createTask error:', err);
    return res.status(500).json({ error: 'Failed to create task', detail: err.message });
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

    // Snapshot before changes for diffing
    const beforeRes = await pool.query('SELECT * FROM ops_tasks WHERE id = $1', [id]);
    if (beforeRes.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const before = beforeRes.rows[0];
    const beforeAssignees = await fetchAssignees(id);
    const beforeReviewers = await fetchReviewers(id);
    const beforeTypes = await fetchTaskTypes(id);

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
      task = before;
    }

    // Update assignees
    const assigneesNew = Array.isArray(person_ids) ? person_ids : (person_id ? [person_id] : null);
    if (assigneesNew) await replaceAssignees(id, assigneesNew);

    // Update reviewers
    const reviewersNew = Array.isArray(reviewer_ids) ? reviewer_ids : (reviewer_id ? [reviewer_id] : null);
    if (reviewersNew) await replaceReviewers(id, reviewersNew);

    if (Array.isArray(type_ids)) {
      await replaceTaskTypes(id, type_ids);
    }

    // Activity log — diff and write entries for every meaningful change
    const userName = req.user.name;
    const fmtDate = v => v ? new Date(v).toISOString().split('T')[0] : 'none';

    if (title !== undefined && title !== before.title) {
      await logActivity(id, req.user.id, `${userName} changed title from "${before.title}" to "${title}"`);
    }
    if (description !== undefined && description !== before.description) {
      await logActivity(id, req.user.id, `${userName} updated the description`);
    }
    if (priority !== undefined && priority !== before.priority) {
      await logActivity(id, req.user.id, `${userName} changed priority from ${before.priority} to ${priority}`);
    }
    if (date !== undefined && fmtDate(date) !== fmtDate(before.date)) {
      await logActivity(id, req.user.id, `${userName} changed start date from ${fmtDate(before.date)} to ${fmtDate(date)}`);
    }
    if (end_date !== undefined && fmtDate(end_date) !== fmtDate(before.end_date)) {
      await logActivity(id, req.user.id, `${userName} changed deadline from ${fmtDate(before.end_date)} to ${fmtDate(end_date)}`);
    }
    if (column_group !== undefined && column_group !== before.column_group) {
      await logActivity(id, req.user.id, `${userName} moved task from "${before.column_group}" to "${column_group}"`);
    }

    if (assigneesNew) {
      const beforeIds = beforeAssignees.map(a => a.id).sort().join(',');
      const afterIds = [...assigneesNew].sort().join(',');
      if (beforeIds !== afterIds) {
        const newNames = await pool.query(`SELECT name FROM ops_users WHERE id = ANY($1)`, [assigneesNew]);
        const oldList = beforeAssignees.map(a => a.name).join(', ') || 'none';
        const newList = newNames.rows.map(r => r.name).join(', ') || 'none';
        await logActivity(id, req.user.id, `${userName} changed assignees from [${oldList}] to [${newList}]`);
      }
    }

    if (reviewersNew) {
      const beforeIds = beforeReviewers.map(r => r.id).sort().join(',');
      const afterIds = [...reviewersNew].sort().join(',');
      if (beforeIds !== afterIds) {
        const newNames = await pool.query(`SELECT name FROM ops_users WHERE id = ANY($1)`, [reviewersNew]);
        const oldList = beforeReviewers.map(r => r.name).join(', ') || 'none';
        const newList = newNames.rows.map(r => r.name).join(', ') || 'none';
        await logActivity(id, req.user.id, `${userName} changed reviewers from [${oldList}] to [${newList}]`);
      }
    }

    if (Array.isArray(type_ids)) {
      const beforeIds = beforeTypes.map(t => t.id).sort().join(',');
      const afterIds = [...type_ids].sort().join(',');
      if (beforeIds !== afterIds) {
        const newNames = type_ids.length > 0
          ? (await pool.query(`SELECT name FROM ops_task_types WHERE id = ANY($1)`, [type_ids])).rows.map(r => r.name).join(', ')
          : 'none';
        const oldList = beforeTypes.map(t => t.name).join(', ') || 'none';
        await logActivity(id, req.user.id, `${userName} changed types from [${oldList}] to [${newNames}]`);
      }
    }

    await enrichTask(task);
    return res.json(task);
  } catch (err) {
    console.error('updateTask error:', err);
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

async function bulkDeleteTasks(req, res) {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array of task UUIDs' });
    }

    const result = await pool.query(
      `DELETE FROM ops_tasks WHERE id = ANY($1) RETURNING id, title`,
      [ids]
    );

    return res.json({ deleted: result.rows.length, tasks: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete tasks' });
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

    // Activity log
    const statusLabels = {
      not_completed: 'Not Completed',
      reviewer: 'Submitted for Review',
      completed: 'Completed',
      idea: 'Moved to Ideas',
      archived: 'Archived',
    };
    await logActivity(id, userId, `${req.user.name} changed status to "${statusLabels[status] || status}"`);

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

async function logActivity(taskId, userId, text) {
  await pool.query(
    `INSERT INTO ops_task_comments (task_id, user_id, text, is_system) VALUES ($1, $2, $3, true)`,
    [taskId, userId, text]
  );
}

async function listComments(req, res) {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT c.id, c.task_id, c.user_id, c.text, c.is_system, c.created_at,
              u.name AS user_name
       FROM ops_task_comments c
       JOIN ops_users u ON u.id = c.user_id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch comments' });
  }
}

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
       RETURNING id, task_id, user_id, text, is_system, created_at`,
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

    if (!assigneeIds.includes(userId) && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only an assigned person or admin can request a pause' });
    }

    // Check no pending pause request already exists
    const existing = await pool.query(
      `SELECT id FROM ops_task_pause_requests WHERE task_id = $1 AND status = 'pending'`,
      [id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A pause request is already pending for this task' });
    }

    // Create pause request
    const result = await pool.query(
      `INSERT INTO ops_task_pause_requests (task_id, requested_by, reason, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id, task_id, status, reason, note, created_at`,
      [id, userId, reason, note || null]
    );

    // Activity log
    const reasonText = reason.replace(/_/g, ' ');
    await logActivity(id, userId, `${req.user.name} requested to pause — Reason: ${reasonText}${note ? '. Note: ' + note : ''}`);

    // Notify reviewers
    const reviewerIds = await getReviewerIds(id);
    emitToUsers(reviewerIds, 'notification', {
      type: 'pause_request',
      task_id: id,
      task_title: task.title,
      request_id: result.rows[0].id,
      reason,
      note: note || null,
      requested_by: req.user.name,
    });

    // Send pause_request card to each reviewer's DM
    try {
      const msg = `⏸ Pause requested: "${task.title}" — Reason: ${reasonText}${note ? '. Note: ' + note : ''}`;
      for (const rId of reviewerIds) {
        const convId = await findOrCreateDirectConversation(userId, rId);
        await pool.query(
          `INSERT INTO ops_messages (conversation_id, sender_id, type, content, task_id, pause_request_id)
           VALUES ($1, $2, 'pause_request', $3, $4, $5)`,
          [convId, userId, msg, id, result.rows[0].id]
        );
      }
    } catch (chatErr) {
      // Don't fail the request if chat fails
    }

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to request pause' });
  }
}

async function approvePauseRequest(req, res) {
  try {
    const { id } = req.params; // pause request id
    const { status } = req.body;
    const userId = req.user.id;

    if (!status || !['approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or denied' });
    }

    const reqResult = await pool.query(
      `SELECT pr.id, pr.task_id, pr.status, pr.requested_by, pr.reason, pr.note, t.title AS task_title
       FROM ops_task_pause_requests pr
       JOIN ops_tasks t ON t.id = pr.task_id
       WHERE pr.id = $1`,
      [id]
    );
    if (reqResult.rows.length === 0) return res.status(404).json({ error: 'Pause request not found' });

    const pauseReq = reqResult.rows[0];
    if (pauseReq.status !== 'pending') {
      return res.status(400).json({ error: 'This request has already been reviewed' });
    }

    // Auth: task reviewer or admin/super_admin
    const reviewerIds = await getReviewerIds(pauseReq.task_id);
    if (!reviewerIds.includes(userId) && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only a reviewer or admin can approve or deny a pause request' });
    }

    await pool.query(
      `UPDATE ops_task_pause_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3`,
      [status, userId, id]
    );

    if (status === 'approved') {
      await pool.query(
        `INSERT INTO ops_task_pauses (task_id, paused_by, reason, note) VALUES ($1, $2, $3, $4)`,
        [pauseReq.task_id, pauseReq.requested_by, pauseReq.reason, pauseReq.note]
      );
      await pool.query('UPDATE ops_tasks SET is_paused = true WHERE id = $1', [pauseReq.task_id]);

      const reasonText = pauseReq.reason.replace(/_/g, ' ');
      await logActivity(pauseReq.task_id, userId, `${req.user.name} approved pause — task is now paused (Reason: ${reasonText})`);
    } else {
      await logActivity(pauseReq.task_id, userId, `${req.user.name} denied the pause request`);
    }

    // Send chat message to assignee↔reviewer conversation
    try {
      const reasonText = pauseReq.reason.replace(/_/g, ' ');
      const chatMsg = status === 'approved'
        ? `✅ Pause approved for "${pauseReq.task_title}" — Reason: ${reasonText}`
        : `❌ Pause request denied for "${pauseReq.task_title}"`;

      const convId = await findOrCreateDirectConversation(pauseReq.requested_by, userId);
      await pool.query(
        `INSERT INTO ops_messages (conversation_id, sender_id, type, content) VALUES ($1, $2, 'text', $3)`,
        [convId, userId, chatMsg]
      );
    } catch (chatErr) {
      // Don't fail the approval if chat fails
    }

    // Notify requester
    emitToUsers([pauseReq.requested_by], 'notification', {
      type: 'pause_request_reviewed',
      task_id: pauseReq.task_id,
      request_id: id,
      status,
      reviewed_by: req.user.name,
    });

    return res.json({ id, status, task_id: pauseReq.task_id, reviewed_by_name: req.user.name });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to review pause request' });
  }
}

async function listPauseRequests(req, res) {
  try {
    const { status, task_id } = req.query;
    const params = [];
    const conditions = [];

    if (status) { params.push(status); conditions.push(`pr.status = $${params.length}`); }
    if (task_id) { params.push(task_id); conditions.push(`pr.task_id = $${params.length}`); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT pr.id, pr.task_id, t.title AS task_title,
              u.name AS requested_by_name, pr.status, pr.reason, pr.note, pr.created_at
       FROM ops_task_pause_requests pr
       JOIN ops_tasks t ON t.id = pr.task_id
       JOIN ops_users u ON u.id = pr.requested_by
       ${where}
       ORDER BY pr.created_at DESC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list pause requests' });
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
    const reviewerIds = await getReviewerIds(id);

    // Assignees, reviewers, and admins can all resume
    const canResume = assigneeIds.includes(userId) || reviewerIds.includes(userId) || ['admin', 'super_admin'].includes(req.user.role);
    if (!canResume) {
      return res.status(403).json({ error: 'Only an assignee, reviewer, or admin can resume this task' });
    }

    await pool.query(
      `UPDATE ops_task_pauses SET resumed_at = CURRENT_DATE WHERE task_id = $1 AND resumed_at IS NULL`,
      [id]
    );
    await pool.query('UPDATE ops_tasks SET is_paused = false WHERE id = $1', [id]);
    await logActivity(id, userId, `${req.user.name} resumed the task`);

    const notifyIds = [...new Set([...assigneeIds, ...reviewerIds])].filter(uid => uid !== userId);
    emitToUsers(notifyIds, 'notification', {
      type: 'task_resumed',
      task_id: id,
      resumed_by: req.user.name,
    });

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
  listTasks, createTask, getTask, updateTask, deleteTask, bulkDeleteTasks,
  changeStatus, listComments, addComment,
  listTaskTypes, createTaskType, updateTaskType, deleteTaskType,
  pauseTask, approvePauseRequest, listPauseRequests, resumeTask, getTaskTime,
  stagnantTasks, archiveTask, reorderTasks,
};
