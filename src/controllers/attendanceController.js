const pool = require('../db');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

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

// Parse login time from raw_value like "11:45-9:45" → "11:45"
function parseLoginTime(raw) {
  if (!raw || raw.trim() === '') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('leave')) return null;
  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) return null;
  const loginPart = trimmed.substring(0, dashIndex).trim();
  // Remove seconds if present (11:45:00 → 11:45)
  const parts = loginPart.split(':');
  if (parts.length >= 2) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
  }
  return loginPart;
}

// Check if login time is late (after 10:00)
function isLate(loginTime) {
  if (!loginTime) return false;
  const parts = loginTime.split(':');
  const hour = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  return (hour > 10) || (hour === 10 && min > 0);
}

// Default date range helper
function defaultDateRange(start_date, end_date) {
  const now = new Date();
  if (!start_date) start_date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  if (!end_date) {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    end_date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
  }
  return { start_date, end_date };
}

// Parse a single clock-time string like "9:30", "11:45", or "11:45:00"
// into { h, m }. Returns null for empty or malformed input.
function parseClockTime(s) {
  if (!s) return null;
  const parts = s.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { h, m };
}

// Infer the worked interval in minutes-since-midnight.
// Convention: raw_value is LOGIN-LOGOUT. Both times are written without
// AM/PM markers; logins are morning (AM), and the logout is assumed to be
// PM whenever its numeric value is ≤ the login time (e.g. "11:45-9:45"
// means 11:45 AM → 9:45 PM = 600 minutes). Same-day half-shifts where the
// logout is genuinely later that morning (e.g. "09:00-11:30") still parse
// as-is because logout > login.
function inferIntervalMinutes(login, logout) {
  const loginMin = login.h * 60 + login.m;
  let logoutMin = logout.h * 60 + logout.m;
  if (logoutMin <= loginMin) {
    logoutMin += 12 * 60;
  }
  return { loginMin, logoutMin, durationMin: logoutMin - loginMin };
}

// Parse hours worked from raw_value like "11:45:00-9:45" → 10 hours.
function parseHours(raw) {
  if (!raw || raw.trim() === '') return 0;

  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('leave')) return 0;

  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) return 0;

  const login = parseClockTime(trimmed.substring(0, dashIndex).trim());
  const logout = parseClockTime(trimmed.substring(dashIndex + 1).trim());
  if (!login || !logout) return 0;

  const { durationMin } = inferIntervalMinutes(login, logout);
  if (durationMin <= 0) return 0;
  return durationMin / 60;
}

// Parse the logout clock time from raw_value like "11:45-9:45" → "21:45"
// (24-hour, PM inference applied). Returns null for leave/absent rows.
function parseLogoutTime(raw) {
  if (!raw || raw.trim() === '') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('leave')) return null;

  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) return null;

  const login = parseClockTime(trimmed.substring(0, dashIndex).trim());
  const logout = parseClockTime(trimmed.substring(dashIndex + 1).trim());
  if (!login || !logout) return null;

  const { logoutMin } = inferIntervalMinutes(login, logout);
  const h = Math.floor(logoutMin / 60) % 24;
  const m = logoutMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
    const rows = result.rows.map(row => ({
      ...row,
      login_time: parseLoginTime(row.raw_value),
      logout_time: parseLogoutTime(row.raw_value),
      hours_worked: Math.round(parseHours(row.raw_value) * 100) / 100,
    }));
    return res.json(rows);
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

async function deleteByDate(req, res) {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
    }

    const result = await pool.query(
      'DELETE FROM ops_attendance WHERE date = $1 RETURNING id, user_id, date',
      [date]
    );

    return res.json({ message: `Deleted ${result.rows.length} record(s) for ${date}`, deleted: result.rows.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete attendance for date' });
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

// ── Excel Import ────────────────────────────────────────────────────────────
// Expected Excel format:
// Row 1: Headers — first column is "date" or "name/email", remaining columns are user names or emails
// Row 2+: date in first column, raw_value in each user column
//
// Example:
// | date       | vijay@celume.com | viswas@celume.com |
// | 2026-04-01 | 11:45-9:45       | 10:30-8:30        |
// | 2026-04-02 | leave            | 11:00-9:00        |
//
// OR with names:
// | date       | vijay | viswas |
// | 2026-04-01 | 11:45-9:45 | 10:30-8:30 |

async function importExcel(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Send as multipart/form-data with field name "file"' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (data.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Get all headers except first (which is date)
    const headers = Object.keys(data[0]);
    const dateKey = headers[0]; // first column = date
    const userKeys = headers.slice(1); // remaining = user columns

    // Resolve user columns to user IDs (match by name or email)
    const userMap = {};
    for (const key of userKeys) {
      const trimmed = key.trim();
      const userResult = await pool.query(
        'SELECT id, name, email FROM ops_users WHERE LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1)',
        [trimmed]
      );
      if (userResult.rows.length > 0) {
        userMap[key] = userResult.rows[0];
      }
    }

    const unmatchedUsers = userKeys.filter(k => !userMap[k]);
    const results = [];
    const errors = [];

    for (const row of data) {
      let dateVal = row[dateKey];

      // Handle Excel serial date numbers
      if (typeof dateVal === 'number') {
        const excelDate = XLSX.SSF.parse_date_code(dateVal);
        dateVal = `${excelDate.y}-${String(excelDate.m).padStart(2, '0')}-${String(excelDate.d).padStart(2, '0')}`;
      }

      // Try to parse date string
      if (!dateVal) continue;
      const dateStr = String(dateVal).trim();
      if (!dateStr) continue;

      for (const key of userKeys) {
        if (!userMap[key]) continue;
        const userId = userMap[key].id;
        const rawValue = String(row[key] || '').trim();

        const { is_leave, leave_type } = parseRawValue(rawValue);

        try {
          const result = await pool.query(
            `INSERT INTO ops_attendance (user_id, date, raw_value, is_leave, leave_type)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, date)
             DO UPDATE SET raw_value = $3, is_leave = $4, leave_type = $5
             RETURNING *`,
            [userId, dateStr, rawValue, is_leave, leave_type]
          );
          results.push(result.rows[0]);
        } catch (rowErr) {
          errors.push({ date: dateStr, user: key, error: rowErr.message });
        }
      }
    }

    return res.json({
      imported: results.length,
      errors: errors.length > 0 ? errors : undefined,
      unmatched_users: unmatchedUsers.length > 0 ? unmatchedUsers : undefined,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to import Excel file' });
  }
}

// ── Detailed Analysis ───────────────────────────────────────────────────────

async function analysis(req, res) {
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
      SELECT a.user_id, u.name AS user_name, a.date, a.raw_value, a.is_leave, a.leave_type
      FROM ops_attendance a
      JOIN ops_users u ON u.id = a.user_id
      WHERE a.date >= $1 AND a.date <= $2
    `;
    const params = [start_date, end_date];

    if (user_id) {
      params.push(user_id);
      query += ` AND a.user_id = $${params.length}`;
    }

    query += ' ORDER BY a.date ASC, u.name ASC';

    const result = await pool.query(query, params);

    // Calculate total working days in the range (exclude weekends)
    const startD = new Date(start_date);
    const endD = new Date(end_date);
    let totalWorkingDays = 0;
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) totalWorkingDays++;
    }

    // Group by user
    const userMap = {};
    for (const row of result.rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = {
          user_id: row.user_id,
          user_name: row.user_name,
          days_present: 0,
          days_leave: 0,
          days_absent: 0,
          total_hours: 0,
          daily_hours: [],
          leave_breakdown: {},
          weekly_hours: {},
        };
      }
      const entry = userMap[row.user_id];
      const hours = parseHours(row.raw_value);
      const dateStr = new Date(row.date).toISOString().split('T')[0];

      if (row.is_leave) {
        entry.days_leave++;
        const lType = row.leave_type || 'leave';
        entry.leave_breakdown[lType] = (entry.leave_breakdown[lType] || 0) + 1;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        entry.days_present++;
        entry.total_hours += hours;
        entry.daily_hours.push({ date: dateStr, hours: Math.round(hours * 100) / 100 });
      }

      // Weekly aggregation
      const weekDate = new Date(row.date);
      const weekStart = new Date(weekDate);
      weekStart.setDate(weekDate.getDate() - weekDate.getDay() + 1); // Monday
      const weekKey = weekStart.toISOString().split('T')[0];
      if (!entry.weekly_hours[weekKey]) entry.weekly_hours[weekKey] = 0;
      entry.weekly_hours[weekKey] += hours;
    }

    // Finalize each user
    const analyses = Object.values(userMap).map(u => {
      u.total_hours = Math.round(u.total_hours * 100) / 100;
      u.avg_hours_per_day = u.days_present > 0
        ? Math.round((u.total_hours / u.days_present) * 100) / 100
        : 0;
      u.days_absent = Math.max(0, totalWorkingDays - u.days_present - u.days_leave);
      u.attendance_percentage = totalWorkingDays > 0
        ? Math.round((u.days_present / totalWorkingDays) * 10000) / 100
        : 0;

      // Convert weekly_hours to array
      u.weekly_hours = Object.entries(u.weekly_hours).map(([week, hours]) => ({
        week_start: week,
        hours: Math.round(hours * 100) / 100,
      }));

      return u;
    });

    return res.json({
      period: { start_date, end_date, total_working_days: totalWorkingDays },
      users: analyses,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate analysis' });
  }
}

// ── Daily Attendance Breakdown ──────────────────────────────────────────────

async function daily(req, res) {
  try {
    let { date } = req.query;
    if (!date) date = new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.date, a.raw_value, a.is_leave, a.leave_type
       FROM ops_attendance a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.date = $1
       ORDER BY u.name`,
      [date]
    );

    const rows = result.rows.map(row => {
      const loginTime = parseLoginTime(row.raw_value);
      const logoutTime = parseLogoutTime(row.raw_value);
      const hoursWorked = parseHours(row.raw_value);
      return {
        user_id: row.user_id,
        user_name: row.user_name,
        date: new Date(row.date).toISOString().split('T')[0],
        raw_value: row.raw_value,
        login_time: loginTime,
        logout_time: logoutTime,
        hours_worked: Math.round(hoursWorked * 100) / 100,
        is_leave: row.is_leave,
        is_late: isLate(loginTime),
        leave_type: row.leave_type,
      };
    });

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get daily attendance' });
  }
}

// ── Attendance Trends ───────────────────────────────────────────────────────

async function trends(req, res) {
  try {
    let { start_date, end_date, group_by } = req.query;
    ({ start_date, end_date } = defaultDateRange(start_date, end_date));
    if (!group_by || !['week', 'month'].includes(group_by)) group_by = 'week';

    const result = await pool.query(
      `SELECT a.user_id, a.date, a.raw_value, a.is_leave
       FROM ops_attendance a
       WHERE a.date >= $1 AND a.date <= $2
       ORDER BY a.date ASC`,
      [start_date, end_date]
    );

    // Get total active users
    const usersResult = await pool.query('SELECT COUNT(*)::int AS cnt FROM ops_users WHERE is_active = true');
    const totalUsers = usersResult.rows[0].cnt;

    // Group by period
    const periods = {};
    for (const row of result.rows) {
      const d = new Date(row.date);
      let periodKey, periodStart, periodEnd;

      if (group_by === 'week') {
        // ISO week
        const dayOfWeek = d.getDay() || 7; // Mon=1, Sun=7
        const monday = new Date(d);
        monday.setDate(d.getDate() - dayOfWeek + 1);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        // ISO week number
        const janFirst = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((d - janFirst) / 86400000 + janFirst.getDay() + 1) / 7);
        periodKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        periodStart = monday.toISOString().split('T')[0];
        periodEnd = sunday.toISOString().split('T')[0];
      } else {
        periodKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        periodStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        periodEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
      }

      if (!periods[periodKey]) {
        periods[periodKey] = { period: periodKey, start: periodStart, end: periodEnd, total_hours: 0, total_present: 0, total_leave: 0, present_days_set: new Set() };
      }

      const p = periods[periodKey];
      if (row.is_leave) {
        p.total_leave++;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        p.total_present++;
        p.total_hours += parseHours(row.raw_value);
      }
    }

    const trendsArr = Object.values(periods).map(p => ({
      period: p.period,
      start: p.start,
      end: p.end,
      avg_hours_per_day: p.total_present > 0 ? Math.round((p.total_hours / p.total_present) * 100) / 100 : 0,
      total_present: p.total_present,
      total_leave: p.total_leave,
      total_users: totalUsers,
    }));

    return res.json(trendsArr);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get attendance trends' });
  }
}

// ── Punctuality Report ──────────────────────────────────────────────────────

async function punctuality(req, res) {
  try {
    let { start_date, end_date } = req.query;
    ({ start_date, end_date } = defaultDateRange(start_date, end_date));

    const result = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.raw_value, a.is_leave
       FROM ops_attendance a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.date >= $1 AND a.date <= $2 AND a.is_leave = false AND a.raw_value != ''
       ORDER BY u.name`,
      [start_date, end_date]
    );

    const userMap = {};
    for (const row of result.rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = {
          user_id: row.user_id,
          user_name: row.user_name,
          late_days: 0,
          login_times_minutes: [],
          short_days: 0,
          total_hours: 0,
          total_days_present: 0,
        };
      }
      const u = userMap[row.user_id];
      u.total_days_present++;

      const loginTime = parseLoginTime(row.raw_value);
      const hours = parseHours(row.raw_value);
      u.total_hours += hours;

      if (isLate(loginTime)) u.late_days++;
      if (hours < 8) u.short_days++;

      if (loginTime) {
        const parts = loginTime.split(':');
        u.login_times_minutes.push(parseInt(parts[0]) * 60 + parseInt(parts[1]));
      }
    }

    const results = Object.values(userMap).map(u => {
      let avg_login_time = null;
      if (u.login_times_minutes.length > 0) {
        const avgMin = Math.round(u.login_times_minutes.reduce((a, b) => a + b, 0) / u.login_times_minutes.length);
        const h = Math.floor(avgMin / 60);
        const m = avgMin % 60;
        avg_login_time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
      return {
        user_id: u.user_id,
        user_name: u.user_name,
        late_days: u.late_days,
        avg_login_time,
        short_days: u.short_days,
        avg_hours: u.total_days_present > 0 ? Math.round((u.total_hours / u.total_days_present) * 100) / 100 : 0,
        total_days_present: u.total_days_present,
      };
    });

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get punctuality report' });
  }
}

// ── User Comparison ─────────────────────────────────────────────────────────

async function comparison(req, res) {
  try {
    let { start_date, end_date } = req.query;
    ({ start_date, end_date } = defaultDateRange(start_date, end_date));

    const result = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.raw_value, a.is_leave, a.leave_type
       FROM ops_attendance a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.date >= $1 AND a.date <= $2
       ORDER BY u.name`,
      [start_date, end_date]
    );

    const userMap = {};
    for (const row of result.rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = {
          user_id: row.user_id,
          user_name: row.user_name,
          total_hours: 0,
          days_present: 0,
          days_leave: 0,
          late_days: 0,
          short_days: 0,
          leave_types: {},
        };
      }
      const u = userMap[row.user_id];

      if (row.is_leave) {
        u.days_leave++;
        const lType = row.leave_type || 'regular';
        u.leave_types[lType] = (u.leave_types[lType] || 0) + 1;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        u.days_present++;
        const hours = parseHours(row.raw_value);
        u.total_hours += hours;
        if (isLate(parseLoginTime(row.raw_value))) u.late_days++;
        if (hours < 8) u.short_days++;
      }
    }

    const results = Object.values(userMap).map(u => ({
      user_id: u.user_id,
      user_name: u.user_name,
      total_hours: Math.round(u.total_hours * 100) / 100,
      days_present: u.days_present,
      days_leave: u.days_leave,
      avg_hours_per_day: u.days_present > 0 ? Math.round((u.total_hours / u.days_present) * 100) / 100 : 0,
      late_days: u.late_days,
      short_days: u.short_days,
      leave_types: u.leave_types,
    }));

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get comparison' });
  }
}

// ── Leave Patterns ──────────────────────────────────────────────────────────

async function leavePatterns(req, res) {
  try {
    let { start_date, end_date } = req.query;
    ({ start_date, end_date } = defaultDateRange(start_date, end_date));

    const result = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.date, a.leave_type
       FROM ops_attendance a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.date >= $1 AND a.date <= $2 AND a.is_leave = true
       ORDER BY u.name, a.date`,
      [start_date, end_date]
    );

    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const userMap = {};

    for (const row of result.rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = {
          user_id: row.user_id,
          user_name: row.user_name,
          total_leaves: 0,
          leaves_by_type: {},
          leaves_by_month_map: {},
          leaves_by_weekday: {},
        };
      }
      const u = userMap[row.user_id];
      u.total_leaves++;

      // By type
      const lType = row.leave_type || 'regular';
      u.leaves_by_type[lType] = (u.leaves_by_type[lType] || 0) + 1;

      // By month
      const d = new Date(row.date);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      u.leaves_by_month_map[monthKey] = (u.leaves_by_month_map[monthKey] || 0) + 1;

      // By weekday
      const dayName = weekdays[d.getDay()];
      u.leaves_by_weekday[dayName] = (u.leaves_by_weekday[dayName] || 0) + 1;
    }

    const results = Object.values(userMap).map(u => ({
      user_id: u.user_id,
      user_name: u.user_name,
      total_leaves: u.total_leaves,
      leaves_by_type: u.leaves_by_type,
      leaves_by_month: Object.entries(u.leaves_by_month_map)
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      leaves_by_weekday: u.leaves_by_weekday,
    }));

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get leave patterns' });
  }
}

module.exports = { list, bulkUpsert, update, delete: deleteEntry, deleteByDate, summary, importExcel, upload, analysis, daily, trends, punctuality, comparison, leavePatterns };
