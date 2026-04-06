const pool = require('../db');
const { emitToUsers } = require('../socket');
const { findOrCreateDirectConversation } = require('../helpers/chatHelpers');

// --- Request Idea Move ---
async function requestIdeaMove(req, res) {
  try {
    const { id } = req.params; // task id
    const { reason } = req.body;
    const userId = req.user.id;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({ error: 'reason is required' });
    }

    // Fetch task
    const taskResult = await pool.query(
      'SELECT id, created_by FROM ops_tasks WHERE id = $1',
      [id]
    );
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Only an assignee can request
    const assigneeResult = await pool.query(
      'SELECT user_id FROM ops_task_assignees WHERE task_id = $1', [id]
    );
    const assigneeIds = assigneeResult.rows.map(r => r.user_id);

    if (!assigneeIds.includes(userId)) {
      return res.status(403).json({ error: 'Only an assigned person can request an idea move' });
    }

    // Tasks assigned by someone else cannot be moved to idea
    if (task.created_by !== userId) {
      return res.status(403).json({ error: 'You cannot move director-assigned tasks to idea. Contact your reviewer.' });
    }

    // Monthly limit: count approved idea requests by this user in current month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStr = monthStart.toISOString().split('T')[0];

    const countResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ops_idea_requests
       WHERE requested_by = $1 AND status = 'approved'
       AND created_at >= $2`,
      [userId, monthStr]
    );
    const movesUsed = parseInt(countResult.rows[0].cnt, 10);

    if (movesUsed >= 3) {
      return res.status(400).json({ error: 'You have used all 3 idea moves this month. Remaining: 0' });
    }

    // Create request
    const result = await pool.query(
      `INSERT INTO ops_idea_requests (task_id, requested_by, reason)
       VALUES ($1, $2, $3) RETURNING id, task_id, status, reason, created_at`,
      [id, userId, reason.trim()]
    );

    const request = result.rows[0];
    request.moves_used_this_month = movesUsed;
    request.moves_remaining = 3 - movesUsed;

    // Notify reviewers and send idea_request card into each DM
    const reviewerResult = await pool.query(
      'SELECT user_id FROM ops_task_reviewers WHERE task_id = $1', [id]
    );
    const reviewerIds = reviewerResult.rows.map(r => r.user_id);
    emitToUsers(reviewerIds, 'notification', {
      type: 'idea_request',
      task_id: id,
      request_id: request.id,
      reason: reason.trim(),
      requested_by: req.user.name,
    });

    try {
      const taskResult = await pool.query('SELECT title FROM ops_tasks WHERE id = $1', [id]);
      const taskTitle = taskResult.rows[0]?.title || '';
      const msg = `💡 Idea move requested: "${taskTitle}" — Reason: ${reason.trim()}`;
      for (const rId of reviewerIds) {
        const convId = await findOrCreateDirectConversation(userId, rId);
        await pool.query(
          `INSERT INTO ops_messages (conversation_id, sender_id, type, content, task_id, idea_request_id)
           VALUES ($1, $2, 'idea_request', $3, $4, $5)`,
          [convId, userId, msg, id, request.id]
        );
      }
    } catch (chatErr) {
      // Don't fail the request if chat fails
    }

    return res.status(201).json(request);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create idea request' });
  }
}

// --- Review Idea Request ---
async function reviewIdeaRequest(req, res) {
  try {
    const { id } = req.params; // idea request id
    const { status } = req.body;
    const userId = req.user.id;

    if (!status || !['approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or denied' });
    }

    // Fetch idea request
    const reqResult = await pool.query(
      `SELECT ir.id, ir.task_id, ir.status, ir.requested_by, t.title AS task_title
       FROM ops_idea_requests ir
       JOIN ops_tasks t ON t.id = ir.task_id
       WHERE ir.id = $1`,
      [id]
    );
    if (reqResult.rows.length === 0) {
      return res.status(404).json({ error: 'Idea request not found' });
    }

    const ideaReq = reqResult.rows[0];

    if (ideaReq.status !== 'pending') {
      return res.status(400).json({ error: 'This request has already been reviewed' });
    }

    // Auth: admin, super_admin, or any task reviewer
    const reviewerResult = await pool.query(
      'SELECT user_id FROM ops_task_reviewers WHERE task_id = $1', [ideaReq.task_id]
    );
    const reviewerIds = reviewerResult.rows.map(r => r.user_id);

    if (!reviewerIds.includes(userId) && !['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only a reviewer or admin can review idea requests' });
    }

    // Update idea request
    await pool.query(
      `UPDATE ops_idea_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3`,
      [status, userId, id]
    );

    let taskStatus = null;
    if (status === 'approved') {
      await pool.query("UPDATE ops_tasks SET status = 'idea' WHERE id = $1", [ideaReq.task_id]);
      taskStatus = 'idea';
    }

    // Get reviewer name
    const reviewerName = req.user.name;

    // Send result message into chat
    try {
      const chatMsg = status === 'approved'
        ? `✅ Idea move approved for "${ideaReq.task_title}" — task moved to Ideas`
        : `❌ Idea move denied for "${ideaReq.task_title}"`;
      const convId = await findOrCreateDirectConversation(ideaReq.requested_by, userId);
      await pool.query(
        `INSERT INTO ops_messages (conversation_id, sender_id, type, content) VALUES ($1, $2, 'text', $3)`,
        [convId, userId, chatMsg]
      );
    } catch (chatErr) {
      // Don't fail the review if chat fails
    }

    // Notify the requester
    emitToUsers([ideaReq.requested_by], 'notification', {
      type: 'idea_request_reviewed',
      request_id: id,
      task_id: ideaReq.task_id,
      status,
      reviewed_by: reviewerName,
    });

    return res.json({
      id,
      status,
      task_status: taskStatus || 'unchanged',
      reviewed_by_name: reviewerName,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to review idea request' });
  }
}

// --- List Idea Requests ---
async function listIdeaRequests(req, res) {
  try {
    const { status } = req.query;

    let query = `
      SELECT ir.id, ir.task_id, t.title AS task_title,
             u.name AS requested_by_name, ir.status, ir.reason, ir.created_at
      FROM ops_idea_requests ir
      JOIN ops_tasks t ON t.id = ir.task_id
      JOIN ops_users u ON u.id = ir.requested_by
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` WHERE ir.status = $${params.length}`;
    }

    query += ' ORDER BY ir.created_at DESC';

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list idea requests' });
  }
}

module.exports = { requestIdeaMove, reviewIdeaRequest, listIdeaRequests };
