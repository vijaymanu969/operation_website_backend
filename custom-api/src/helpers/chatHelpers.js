const pool = require('../db');

/**
 * Find an existing direct conversation between two users, or create one.
 * Idempotent — calling twice for the same pair returns the same conversation.
 */
async function findOrCreateDirectConversation(userId1, userId2) {
  // Check if a direct conversation already exists between these two users
  const existing = await pool.query(
    `SELECT c.id
     FROM ops_conversations c
     JOIN ops_conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
     JOIN ops_conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
     WHERE c.type = 'direct'`,
    [userId1, userId2]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Create new direct conversation
  const conv = await pool.query(
    `INSERT INTO ops_conversations (type) VALUES ('direct') RETURNING id`
  );
  const convId = conv.rows[0].id;

  await pool.query(
    'INSERT INTO ops_conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
    [convId, userId1, userId2]
  );

  return convId;
}

/**
 * Create a task_review message in a conversation.
 * This is the "review card" that appears in chat when a task is submitted for review.
 */
async function createTaskReviewMessage(conversationId, senderId, taskId) {
  const result = await pool.query(
    `INSERT INTO ops_messages (conversation_id, sender_id, type, task_id, review_status)
     VALUES ($1, $2, 'task_review', $3, 'pending')
     RETURNING *`,
    [conversationId, senderId, taskId]
  );
  return result.rows[0];
}

module.exports = { findOrCreateDirectConversation, createTaskReviewMessage };
