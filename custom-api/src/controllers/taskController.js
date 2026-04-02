const pool = require('../db');
const { findOrCreateDirectConversation, createTaskReviewMessage } = require('../helpers/chatHelpers');

// Helper: fetch types for a single task
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

// Helper: replace type assignments for a task
async function replaceTaskTypes(taskId, typeIds) {
  await pool.query('DELETE FROM ops_task_type_assignments WHERE task_id = $1', [taskId]);
  for (const typeId of typeIds) {
    await pool.query(
      'INSERT INTO ops_task_type_assignments (task_id, type_id) VALUES ($1, $2)',
      [taskId, typeId]
    );
  }
}

async function listTasks(req, res) {
  try {
    const { status, priority, person_id, reviewer_id, column_group, type_id } = req.query;

    let query = `
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.date, t.end_date, t.person_id, t.reviewer_id, t.created_by,
             t.column_group, t.sort_order, t.created_at, t.updated_at,
             p.name AS person_name, r.name AS reviewer_name
      FROM ops_tasks t
      LEFT JOIN ops_users p ON p.id = t.person_id
      LEFT JOIN ops_users r ON r.id = t.reviewer_id
    `;

    const conditions = [];
    const params = [];

    if (type_id) {
      query += ' JOIN ops_task_type_assignments ta ON ta.task_id = t.id';
      params.push(type_id);
      conditions.push(`ta.type_id = $${params.length}`);
    }

    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`t.priority = $${params.length}`); }
    if (person_id) { params.push(person_id); conditions.push(`t.person_id = $${params.length}`); }
    if (reviewer_id) { params.push(reviewer_id); conditions.push(`t.reviewer_id = $${params.length}`); }
    if (column_group) { params.push(column_group); conditions.push(`t.column_group = $${params.length}`); }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY t.sort_order ASC, t.created_at DESC';

    const result = await pool.query(query, params);

    // Fetch types for each task
    const tasks = [];
    for (const task of result.rows) {
      task.types = await fetchTaskTypes(task.id);
      tasks.push(task);
    }

    return res.json(tasks);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list tasks' });
  }
}

async function createTask(req, res) {
  try {
    const { title, description, priority, date, end_date, person_id, reviewer_id, column_group, type_ids } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await pool.query(
      `INSERT INTO ops_tasks (title, description, priority, date, end_date, person_id, reviewer_id, created_by, column_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        title,
        description || '',
        priority || 'medium',
        date || null,
        end_date || null,
        person_id || null,
        reviewer_id || null,
        req.user.id,
        column_group || 'todo',
      ]
    );

    const task = result.rows[0];

    if (Array.isArray(type_ids) && type_ids.length > 0) {
      await replaceTaskTypes(task.id, type_ids);
    }

    task.types = await fetchTaskTypes(task.id);
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
              t.date, t.end_date, t.person_id, t.reviewer_id, t.created_by,
              t.column_group, t.sort_order, t.created_at, t.updated_at,
              p.name AS person_name, r.name AS reviewer_name
       FROM ops_tasks t
       LEFT JOIN ops_users p ON p.id = t.person_id
       LEFT JOIN ops_users r ON r.id = t.reviewer_id
       WHERE t.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = result.rows[0];
    task.types = await fetchTaskTypes(task.id);

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
    const { title, description, priority, date, end_date, person_id, reviewer_id, column_group, sort_order, type_ids } = req.body;

    // Check task exists
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
    if (person_id !== undefined) { params.push(person_id); fields.push(`person_id = $${params.length}`); }
    if (reviewer_id !== undefined) { params.push(reviewer_id); fields.push(`reviewer_id = $${params.length}`); }
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
      task = existing.rows[0];
    }

    if (Array.isArray(type_ids)) {
      await replaceTaskTypes(id, type_ids);
    }

    task.types = await fetchTaskTypes(id);
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

async function changeStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['not_completed', 'reviewer', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: not_completed, reviewer, or completed' });
    }

    // Fetch current task
    const taskResult = await pool.query(
      'SELECT id, status, person_id, reviewer_id FROM ops_tasks WHERE id = $1',
      [id]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    const userId = req.user.id;

    // REVIEWER FLOW RULES
    if (status === 'reviewer') {
      // Submit for review: only from not_completed, only by assigned person
      if (task.status !== 'not_completed') {
        return res.status(403).json({ error: 'Can only submit for review when status is not_completed' });
      }
      if (task.person_id !== userId && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only the assigned person can submit for review' });
      }
    }

    if (status === 'completed') {
      // Approve: only from reviewer, only by reviewer_id
      if (task.status !== 'reviewer') {
        return res.status(403).json({ error: 'Can only complete a task that is in review' });
      }
      if (task.reviewer_id !== userId && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only the reviewer can approve this task' });
      }
    }

    if (status === 'not_completed' && task.status === 'reviewer') {
      // Reject: only from reviewer, only by reviewer_id
      if (task.reviewer_id !== userId && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only the reviewer can reject this task' });
      }
    }

    const result = await pool.query(
      'UPDATE ops_tasks SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    const updated = result.rows[0];

    // Chat integration: when submitted for review, create a task review card in chat
    if (status === 'reviewer' && updated.person_id && updated.reviewer_id) {
      try {
        const convId = await findOrCreateDirectConversation(updated.person_id, updated.reviewer_id);
        await createTaskReviewMessage(convId, updated.person_id, updated.id);
      } catch (chatErr) {
        // Don't fail the status change if chat integration fails
      }
    }

    updated.types = await fetchTaskTypes(id);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to change status' });
  }
}

async function addComment(req, res) {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    // Check task exists
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

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

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

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE ops_task_types SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task type not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update task type' });
  }
}

async function deleteTaskType(req, res) {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM ops_task_types WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task type not found' });
    }

    return res.json({ message: 'Task type deleted', type: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete task type' });
  }
}

module.exports = {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  changeStatus,
  addComment,
  listTaskTypes,
  createTaskType,
  updateTaskType,
  deleteTaskType,
};
