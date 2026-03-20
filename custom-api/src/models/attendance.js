const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const Attendance = {
  async getAll() {
    const result = await pool.query(
      'SELECT * FROM attendance ORDER BY date DESC, created_at DESC'
    );
    return result.rows;
  },

  async getByUserId(userId) {
    const result = await pool.query(
      'SELECT * FROM attendance WHERE user_id = $1 ORDER BY date DESC',
      [userId]
    );
    return result.rows;
  },

  async checkIn(userId, notes) {
    const now = new Date();
    const result = await pool.query(
      `INSERT INTO attendance (user_id, check_in, date, status, notes)
       VALUES ($1, $2, $3, 'present', $4)
       RETURNING *`,
      [userId, now, now.toISOString().split('T')[0], notes]
    );
    return result.rows[0];
  },

  async checkOut(userId) {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `UPDATE attendance SET check_out = NOW()
       WHERE user_id = $1 AND date = $2 AND check_out IS NULL
       RETURNING *`,
      [userId, today]
    );
    return result.rows[0];
  },
};

module.exports = Attendance;
