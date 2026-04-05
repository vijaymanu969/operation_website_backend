const pool = require('../db');
const { findOrCreateDirectConversation } = require('../helpers/chatHelpers');
const { emitToConversation, emitToUser } = require('../socket');

async function listConversations(req, res) {
  try {
    const userId = req.user.id;
    const { search } = req.query;

    const convResult = await pool.query(
      `SELECT c.id, c.type, c.name, c.created_at
       FROM ops_conversations c
       JOIN ops_conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = $1`,
      [userId]
    );

    const conversations = [];

    for (const conv of convResult.rows) {
      const members = await pool.query(
        `SELECT u.id, u.name, u.role
         FROM ops_conversation_members m
         JOIN ops_users u ON u.id = m.user_id
         WHERE m.conversation_id = $1`,
        [conv.id]
      );

      const lastMsg = await pool.query(
        `SELECT msg.content, msg.type, msg.created_at, u.name AS sender_name
         FROM ops_messages msg
         JOIN ops_users u ON u.id = msg.sender_id
         WHERE msg.conversation_id = $1
         ORDER BY msg.created_at DESC
         LIMIT 1`,
        [conv.id]
      );

      let displayName = conv.name;
      if (conv.type === 'direct') {
        const other = members.rows.find(m => m.id !== userId);
        displayName = other ? other.name : 'Unknown';
      }

      // Apply search filter
      if (search) {
        const q = search.toLowerCase();
        const nameMatch = displayName && displayName.toLowerCase().includes(q);
        const memberMatch = members.rows.some(m => m.name.toLowerCase().includes(q));
        if (!nameMatch && !memberMatch) continue;
      }

      conversations.push({
        id: conv.id,
        type: conv.type,
        name: displayName,
        created_at: conv.created_at,
        members: members.rows,
        last_message: lastMsg.rows[0] || null,
      });
    }

    conversations.sort((a, b) => {
      const aTime = a.last_message ? new Date(a.last_message.created_at) : new Date(a.created_at);
      const bTime = b.last_message ? new Date(b.last_message.created_at) : new Date(b.created_at);
      return bTime - aTime;
    });

    return res.json(conversations);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list conversations' });
  }
}

async function createConversation(req, res) {
  try {
    const { member_ids, type, name } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(member_ids) || member_ids.length === 0) {
      return res.status(400).json({ error: 'member_ids is required' });
    }

    const convType = type || 'direct';

    if (convType === 'direct') {
      if (member_ids.length !== 1) {
        return res.status(400).json({ error: 'Direct conversations require exactly 1 other member_id' });
      }

      const otherId = member_ids[0];
      if (otherId === userId) {
        return res.status(400).json({ error: 'Cannot create a conversation with yourself' });
      }

      const convId = await findOrCreateDirectConversation(userId, otherId);

      const conv = await pool.query('SELECT * FROM ops_conversations WHERE id = $1', [convId]);
      const members = await pool.query(
        `SELECT u.id, u.name, u.role
         FROM ops_conversation_members m
         JOIN ops_users u ON u.id = m.user_id
         WHERE m.conversation_id = $1`,
        [convId]
      );

      const other = members.rows.find(m => m.id !== userId);

      return res.status(201).json({
        ...conv.rows[0],
        name: other ? other.name : 'Unknown',
        members: members.rows,
      });
    }

    if (convType === 'group') {
      if (!name) {
        return res.status(400).json({ error: 'Group conversations require a name' });
      }

      const conv = await pool.query(
        `INSERT INTO ops_conversations (type, name) VALUES ('group', $1) RETURNING *`,
        [name]
      );
      const convId = conv.rows[0].id;

      const allMembers = [...new Set([userId, ...member_ids])];
      for (const memberId of allMembers) {
        await pool.query(
          'INSERT INTO ops_conversation_members (conversation_id, user_id) VALUES ($1, $2)',
          [convId, memberId]
        );
      }

      const members = await pool.query(
        `SELECT u.id, u.name, u.role
         FROM ops_conversation_members m
         JOIN ops_users u ON u.id = m.user_id
         WHERE m.conversation_id = $1`,
        [convId]
      );

      return res.status(201).json({
        ...conv.rows[0],
        members: members.rows,
      });
    }

    return res.status(400).json({ error: 'Invalid type. Must be direct or group' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create conversation' });
  }
}

async function getMessages(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const cursor = req.query.cursor;
    let limit = parseInt(req.query.limit) || 50;
    if (limit > 100) limit = 100;

    const membership = await pool.query(
      'SELECT 1 FROM ops_conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [id, userId]
    );
    if (membership.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this conversation' });
    }

    let query = `
      SELECT msg.id, msg.conversation_id, msg.sender_id, msg.type, msg.content,
             msg.task_id, msg.review_status, msg.created_at, msg.updated_at,
             u.name AS sender_name
      FROM ops_messages msg
      JOIN ops_users u ON u.id = msg.sender_id
      WHERE msg.conversation_id = $1
    `;
    const params = [id];

    if (cursor) {
      params.push(cursor);
      query += ` AND msg.created_at < $${params.length}`;
    }

    query += ' ORDER BY msg.created_at DESC';
    params.push(limit + 1);
    query += ` LIMIT $${params.length}`;

    const result = await pool.query(query, params);

    const hasMore = result.rows.length > limit;
    const messages = result.rows.slice(0, limit);

    // For task_review messages, fetch task details (using junction tables)
    for (const msg of messages) {
      if (msg.type === 'task_review' && msg.task_id) {
        const taskResult = await pool.query(
          `SELECT t.id, t.title, t.description, t.priority, t.status,
                  t.date, t.column_group
           FROM ops_tasks t
           WHERE t.id = $1`,
          [msg.task_id]
        );
        if (taskResult.rows[0]) {
          const task = taskResult.rows[0];
          // Fetch assignees and reviewers
          const assignees = await pool.query(
            `SELECT u.id, u.name FROM ops_task_assignees a JOIN ops_users u ON u.id = a.user_id WHERE a.task_id = $1`,
            [msg.task_id]
          );
          const reviewers = await pool.query(
            `SELECT u.id, u.name FROM ops_task_reviewers r JOIN ops_users u ON u.id = r.user_id WHERE r.task_id = $1`,
            [msg.task_id]
          );
          task.assignees = assignees.rows;
          task.reviewers = reviewers.rows;
          msg.task = task;
        } else {
          msg.task = null;
        }
      }
    }

    return res.json({ messages, has_more: hasMore });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
}

async function sendMessage(req, res) {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const membership = await pool.query(
      'SELECT 1 FROM ops_conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [id, userId]
    );
    if (membership.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this conversation' });
    }

    const result = await pool.query(
      `INSERT INTO ops_messages (conversation_id, sender_id, type, content)
       VALUES ($1, $2, 'text', $3)
       RETURNING *`,
      [id, userId, content.trim()]
    );

    const message = result.rows[0];
    message.sender_name = req.user.name;

    // Emit real-time event to conversation room
    emitToConversation(id, 'new_message', message);

    // Also notify all members who aren't in the room
    const members = await pool.query(
      'SELECT user_id FROM ops_conversation_members WHERE conversation_id = $1 AND user_id != $2',
      [id, userId]
    );
    for (const m of members.rows) {
      emitToUser(m.user_id, 'notification', {
        type: 'new_message',
        conversation_id: id,
        sender_name: req.user.name,
        content: content.trim().substring(0, 100),
      });
    }

    return res.status(201).json(message);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send message' });
  }
}

async function reviewTask(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user.id;

    if (!status || !['completed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be completed or rejected' });
    }

    const msgResult = await pool.query('SELECT * FROM ops_messages WHERE id = $1', [id]);
    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const message = msgResult.rows[0];

    if (message.type !== 'task_review') {
      return res.status(400).json({ error: 'This message is not a task review' });
    }

    if (message.review_status !== 'pending') {
      return res.status(400).json({ error: 'This review has already been processed' });
    }

    // Check user is a reviewer of the linked task
    const reviewerCheck = await pool.query(
      'SELECT 1 FROM ops_task_reviewers WHERE task_id = $1 AND user_id = $2',
      [message.task_id, userId]
    );

    if (reviewerCheck.rows.length === 0 && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a reviewer can approve or reject this task' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE ops_messages SET review_status = $1 WHERE id = $2',
        [status, id]
      );

      const newTaskStatus = status === 'completed' ? 'completed' : 'not_completed';
      let updateSQL = 'UPDATE ops_tasks SET status = $1';
      if (status === 'completed') updateSQL += ', completed_at = CURRENT_DATE';
      updateSQL += ' WHERE id = $2 RETURNING *';

      const updatedTask = await client.query(updateSQL, [newTaskStatus, message.task_id]);

      await client.query('COMMIT');

      const updatedMsg = await pool.query(
        `SELECT msg.*, u.name AS sender_name
         FROM ops_messages msg
         JOIN ops_users u ON u.id = msg.sender_id
         WHERE msg.id = $1`,
        [id]
      );

      // Emit real-time event
      emitToConversation(message.conversation_id, 'review_updated', {
        message_id: id,
        review_status: status,
        task_status: updatedTask.rows[0].status,
      });

      // Notify assignees
      const assignees = await pool.query(
        'SELECT user_id FROM ops_task_assignees WHERE task_id = $1', [message.task_id]
      );
      for (const a of assignees.rows) {
        emitToUser(a.user_id, 'notification', {
          type: 'task_review_result',
          task_id: message.task_id,
          task_title: updatedTask.rows[0].title,
          result: status,
          reviewer_name: req.user.name,
        });
      }

      return res.json({
        message: updatedMsg.rows[0],
        task_status: updatedTask.rows[0].status,
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to review task' });
  }
}

module.exports = { listConversations, createConversation, getMessages, sendMessage, reviewTask };
