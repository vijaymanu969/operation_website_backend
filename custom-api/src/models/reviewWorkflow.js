const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const ReviewWorkflow = {
  async getReviewQueue(reviewerId) {
    const result = await pool.query(
      `SELECT * FROM review_workflow
       WHERE reviewer_id = $1 AND status IN ('submitted')
       ORDER BY submitted_at ASC`,
      [reviewerId]
    );
    return result.rows;
  },

  async submit(taskId, assigneeId) {
    const result = await pool.query(
      `UPDATE review_workflow SET status = 'submitted', submitted_at = NOW()
       WHERE task_id = $1 AND assignee_id = $2 AND status = 'in_progress'
       RETURNING *`,
      [taskId, assigneeId]
    );
    return result.rows[0];
  },

  async approve(taskId, reviewerId, note) {
    const result = await pool.query(
      `UPDATE review_workflow SET status = 'approved', reviewed_at = NOW(), reviewer_note = $3
       WHERE task_id = $1 AND reviewer_id = $2 AND status = 'submitted'
       RETURNING *`,
      [taskId, reviewerId, note]
    );
    return result.rows[0];
  },

  async reject(taskId, reviewerId, note) {
    const result = await pool.query(
      `UPDATE review_workflow SET status = 'rejected', reviewed_at = NOW(), reviewer_note = $3
       WHERE task_id = $1 AND reviewer_id = $2 AND status = 'submitted'
       RETURNING *`,
      [taskId, reviewerId, note]
    );
    return result.rows[0];
  },
};

module.exports = ReviewWorkflow;
