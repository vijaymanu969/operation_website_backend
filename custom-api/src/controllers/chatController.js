const pool = require('../db');
const { findOrCreateDirectConversation } = require('../helpers/chatHelpers');

async function listConversations(req, res) {
  try {
    const userId = req.user.id;

    // Get all conversations the user is a member of
    const convResult = await pool.query(
      `SELECT c.id, c.type, c.name, c.created_at
       FROM ops_conversations c
       JOIN ops_conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = $1`,
      [userId]
    );

    const conversations = [];

    for (const conv of convResult.rows) {
      // Get members
      const members = await pool.query(
        `SELECT u.id, u.name, u.role
         FROM ops_conversation_members m
         JOIN ops_users u ON u.id = m.user_id
         WHERE m.conversation_id = $1`,
        [conv.id]
      );

      // Get last message
      const lastMsg = await pool.query(
        `SELECT msg.content, msg.type, msg.created_at, u.name AS sender_name
         FROM ops_messages msg
         JOIN ops_users u ON u.id = msg.sender_id
         WHERE msg.conversation_id = $1
         ORDER BY msg.created_at DESC
         LIMIT 1`,
        [conv.id]
      );

      // For direct conversations, set display_name to the other member
      let displayName = conv.name;
      if (conv.type === 'direct') {
        const other = members.rows.find(m => m.id !== userId);
        displayName = other ? other.name : 'Unknown';
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

    // Sort by last message time (most recent first)
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

      // Fetch full conversation to return
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

      // Add current user + all member_ids
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

    // Verify user is a member
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

    // For task_review messages, fetch task details
    for (const msg of messages) {
      if (msg.type === 'task_review' && msg.task_id) {
        const taskResult = await pool.query(
          `SELECT t.id, t.title, t.description, t.priority, t.status,
                  t.person_id, t.reviewer_id, t.date, t.column_group,
                  p.name AS person_name, r.name AS reviewer_name
           FROM ops_tasks t
           LEFT JOIN ops_users p ON p.id = t.person_id
           LEFT JOIN ops_users r ON r.id = t.reviewer_id
           WHERE t.id = $1`,
          [msg.task_id]
        );
        msg.task = taskResult.rows[0] || null;
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

    // Verify user is a member
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

    // Fetch the message
    const msgResult = await pool.query(
      'SELECT * FROM ops_messages WHERE id = $1',
      [id]
    );

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

    // Check the user is the reviewer of the linked task
    const taskResult = await pool.query(
      'SELECT id, reviewer_id, status FROM ops_tasks WHERE id = $1',
      [message.task_id]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Linked task not found' });
    }

    const task = taskResult.rows[0];

    if (task.reviewer_id !== userId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only the reviewer can approve or reject this task' });
    }

    // Transaction: update both message and task
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update message review status
      await client.query(
        'UPDATE ops_messages SET review_status = $1 WHERE id = $2',
        [status, id]
      );

      // Update task status
      const newTaskStatus = status === 'completed' ? 'completed' : 'not_completed';
      const updatedTask = await client.query(
        'UPDATE ops_tasks SET status = $1 WHERE id = $2 RETURNING *',
        [newTaskStatus, message.task_id]
      );

      await client.query('COMMIT');

      // Fetch updated message
      const updatedMsg = await pool.query(
        `SELECT msg.*, u.name AS sender_name
         FROM ops_messages msg
         JOIN ops_users u ON u.id = msg.sender_id
         WHERE msg.id = $1`,
        [id]
      );

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
