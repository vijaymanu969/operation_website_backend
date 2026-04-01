const pool = require('../db');

// Parse raw_value to determine leave status and type
// "11:45:00-9:45" → present, extract hours
// "leave" or "leave(festival)" → is_leave=true, leave_type=raw_value
// "" → absent
function parseRawValue(raw) {
  if (!raw || raw.trim() === '') {
    return { is_leave: false, leave_type: null };
  }

  const trimmed = raw.trim().toLowerCase();

  if (trimmed.startsWith('leave')) {
    return { is_leave: true, leave_type: raw.trim() };
  }

  return { is_leave: false, leave_type: null };
}

// Parse hours from raw_value like "11:45:00-9:45" → 9.75 hours
function parseHours(raw) {
  if (!raw || raw.trim() === '') return 0;

  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('leave')) return 0;

  // Look for pattern like "HH:MM:SS-H:MM" or "HH:MM-H:MM"
  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) return 0;

  const hoursPart = trimmed.substring(dashIndex + 1).trim();
  const parts = hoursPart.split(':');

  if (parts.length >= 2) {
    const h = parseFloat(parts[0]) || 0;
    const m = parseFloat(parts[1]) || 0;
    return h + m / 60;
  }

  return parseFloat(hoursPart) || 0;
}

async function list(req, res) {
  try {
    let { start_date, end_date, user_id } = req.query;

    // Default to current month
    if (!start_date || !end_date) {
      const now = new Date();
      start_date = start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      end_date = end_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    }

    let query = `
      SELECT a.id, a.user_id, u.name AS user_name, a.date, a.raw_value,
             a.is_leave, a.leave_type, a.created_at, a.updated_at
      FROM ops_attendance a
      JOIN ops_users u ON u.id = a.user_id
      WHERE a.date >= $1 AND a.date <= $2
    `;
    const params = [start_date, end_date];

    if (user_id) {
      params.push(user_id);
      query += ` AND a.user_id = $${params.length}`;
    }

    query += ' ORDER BY a.date DESC, u.name ASC';

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list attendance' });
  }
}

async function bulkUpsert(req, res) {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows must be a non-empty array of {user_id, date, raw_value}' });
    }

    const results = [];

    for (const row of rows) {
      const { user_id, date, raw_value } = row;
      if (!user_id || !date) continue;

      const { is_leave, leave_type } = parseRawValue(raw_value);

      const result = await pool.query(
        `INSERT INTO ops_attendance (user_id, date, raw_value, is_leave, leave_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, date)
         DO UPDATE SET raw_value = $3, is_leave = $4, leave_type = $5
         RETURNING *`,
        [user_id, date, raw_value || '', is_leave, leave_type]
      );

      results.push(result.rows[0]);
    }

    return res.json({ upserted: results.length, rows: results });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to bulk upsert attendance' });
  }
}

async function update(req, res) {
  try {
    const { id } = req.params;
    const { raw_value } = req.body;

    if (raw_value === undefined) {
      return res.status(400).json({ error: 'raw_value is required' });
    }

    const { is_leave, leave_type } = parseRawValue(raw_value);

    const result = await pool.query(
      `UPDATE ops_attendance SET raw_value = $1, is_leave = $2, leave_type = $3
       WHERE id = $4 RETURNING *`,
      [raw_value, is_leave, leave_type, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update attendance' });
  }
}

async function deleteEntry(req, res) {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM ops_attendance WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    return res.json({ message: 'Deleted', row: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete attendance' });
  }
}

async function summary(req, res) {
  try {
    let { start_date, end_date } = req.query;

    // Default to current month
    if (!start_date || !end_date) {
      const now = new Date();
      start_date = start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      end_date = end_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    }

    const result = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.raw_value, a.is_leave
       FROM ops_attendance a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.date >= $1 AND a.date <= $2
       ORDER BY u.name`,
      [start_date, end_date]
    );

    // Group by user
    const userMap = {};
    for (const row of result.rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = {
          user_id: row.user_id,
          user_name: row.user_name,
          days_present: 0,
          days_leave: 0,
          total_hours: 0,
        };
      }
      const entry = userMap[row.user_id];
      if (row.is_leave) {
        entry.days_leave++;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        entry.days_present++;
        entry.total_hours += parseHours(row.raw_value);
      }
    }

    // Round hours
    const summaries = Object.values(userMap).map(u => ({
      ...u,
      total_hours: Math.round(u.total_hours * 100) / 100,
    }));

    return res.json(summaries);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate summary' });
  }
}

module.exports = { list, bulkUpsert, update, delete: deleteEntry, summary };
