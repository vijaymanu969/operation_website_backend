const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function getSummary(req, res) {
  try {
    const attendanceCount = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN status = 'present' THEN 1 END) as present,
              COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent
       FROM attendance WHERE date = CURRENT_DATE`
    );

    const taskStats = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM review_workflow
       GROUP BY status`
    );

    res.json({
      attendance: attendanceCount.rows[0],
      tasks: taskStats.rows,
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
  }
}

module.exports = { getSummary };
