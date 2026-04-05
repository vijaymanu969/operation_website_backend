const pool = require('../db');

// Helper: parse hours from raw_value (same logic as attendanceController)
function parseHours(raw) {
  if (!raw || raw.trim() === '') return 0;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('leave')) return 0;
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

function parseLoginTime(raw) {
  if (!raw || raw.trim() === '') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('leave')) return null;
  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) return null;
  const loginPart = trimmed.substring(0, dashIndex).trim();
  const parts = loginPart.split(':');
  if (parts.length >= 2) return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
  return loginPart;
}

function isLate(loginTime) {
  if (!loginTime) return false;
  const parts = loginTime.split(':');
  const hour = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  return (hour > 10) || (hour === 10 && min > 0);
}

async function dashboard(req, res) {
  try {
    let { start_date, end_date } = req.query;

    // Default to current month
    if (!start_date || !end_date) {
      const now = new Date();
      start_date = start_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      end_date = end_date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
    }

    // Tasks by status
    const statusResult = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM ops_tasks GROUP BY status`
    );
    const tasks_by_status = {};
    for (const row of statusResult.rows) {
      tasks_by_status[row.status] = row.count;
    }

    // Tasks by priority
    const priorityResult = await pool.query(
      `SELECT priority, COUNT(*)::int AS count FROM ops_tasks GROUP BY priority`
    );
    const tasks_by_priority = {};
    for (const row of priorityResult.rows) {
      tasks_by_priority[row.priority] = row.count;
    }

    // Tasks per person (via junction table)
    const perPersonResult = await pool.query(
      `SELECT a.user_id, u.name AS user_name,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE t.status = 'not_completed')::int AS in_progress
       FROM ops_task_assignees a
       JOIN ops_tasks t ON t.id = a.task_id
       JOIN ops_users u ON u.id = a.user_id
       GROUP BY a.user_id, u.name`
    );

    // Stagnant count
    const stagnantResult = await pool.query(
      `SELECT t.id, t.created_at FROM ops_tasks t WHERE t.status = 'not_completed'`
    );
    const stagnant_count = { at_risk: 0, stagnant: 0, dead: 0 };
    for (const task of stagnantResult.rows) {
      // Get last meaningful activity
      const actResult = await pool.query(
        `SELECT MAX(ts) AS last_activity FROM (
           SELECT MAX(created_at) AS ts FROM ops_task_pauses WHERE task_id = $1
           UNION ALL
           SELECT MAX(created_at) AS ts FROM ops_task_comments WHERE task_id = $1
         ) sub`,
        [task.id]
      );
      const lastActivity = actResult.rows[0]?.last_activity || task.created_at;
      const days = Math.floor((new Date() - new Date(lastActivity)) / (1000 * 60 * 60 * 24));
      if (days >= 14) stagnant_count.dead++;
      else if (days >= 7) stagnant_count.stagnant++;
      else if (days >= 3) stagnant_count.at_risk++;
    }

    // Attendance summary
    const attResult = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.raw_value, a.is_leave
       FROM ops_attendance a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.date >= $1 AND a.date <= $2`,
      [start_date, end_date]
    );
    const userMap = {};
    for (const row of attResult.rows) {
      if (!userMap[row.user_id]) {
        userMap[row.user_id] = { user_id: row.user_id, user_name: row.user_name, days_present: 0, days_leave: 0, total_hours: 0 };
      }
      const entry = userMap[row.user_id];
      if (row.is_leave) {
        entry.days_leave++;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        entry.days_present++;
        entry.total_hours += parseHours(row.raw_value);
      }
    }
    const attendance_summary = Object.values(userMap).map(u => ({
      ...u,
      total_hours: Math.round(u.total_hours * 100) / 100,
    }));

    // Average drift
    const driftResult = await pool.query(
      `SELECT date, end_date, completed_at FROM ops_tasks
       WHERE completed_at IS NOT NULL AND date IS NOT NULL AND end_date IS NOT NULL`
    );
    let totalDrift = 0;
    let driftCount = 0;
    for (const t of driftResult.rows) {
      // Get paused days for this task
      const pauseRes = await pool.query(
        `SELECT paused_at, resumed_at FROM ops_task_pauses WHERE task_id = $1`,
        [t.id]
      );
      let pausedDays = 0;
      for (const p of (pauseRes?.rows || [])) {
        const s = new Date(p.paused_at);
        const e = p.resumed_at ? new Date(p.resumed_at) : new Date();
        pausedDays += Math.max(0, Math.floor((e - s) / (1000 * 60 * 60 * 24)));
      }
      const planned = Math.floor((new Date(t.end_date) - new Date(t.date)) / (1000 * 60 * 60 * 24));
      const actual = Math.floor((new Date(t.completed_at) - new Date(t.date)) / (1000 * 60 * 60 * 24)) - pausedDays;
      totalDrift += actual - planned;
      driftCount++;
    }

    // Attendance overview (today + this month)
    const today = new Date().toISOString().split('T')[0];
    const todayResult = await pool.query(
      `SELECT a.raw_value, a.is_leave FROM ops_attendance a WHERE a.date = $1`,
      [today]
    );
    let teamPresentToday = 0, teamOnLeaveToday = 0, teamLateToday = 0, todayTotalHours = 0;
    for (const row of todayResult.rows) {
      if (row.is_leave) {
        teamOnLeaveToday++;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        teamPresentToday++;
        todayTotalHours += parseHours(row.raw_value);
        if (isLate(parseLoginTime(row.raw_value))) teamLateToday++;
      }
    }

    // Top performer & most leaves this month
    const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
    const monthAttResult = await pool.query(
      `SELECT a.user_id, u.name AS user_name, a.raw_value, a.is_leave
       FROM ops_attendance a JOIN ops_users u ON u.id = a.user_id
       WHERE a.date >= $1 AND a.date <= $2`,
      [monthStart, today]
    );
    const monthUsers = {};
    for (const row of monthAttResult.rows) {
      if (!monthUsers[row.user_id]) {
        monthUsers[row.user_id] = { user_name: row.user_name, total_hours: 0, total_leaves: 0 };
      }
      if (row.is_leave) {
        monthUsers[row.user_id].total_leaves++;
      } else if (row.raw_value && row.raw_value.trim() !== '') {
        monthUsers[row.user_id].total_hours += parseHours(row.raw_value);
      }
    }
    const monthArr = Object.values(monthUsers);
    const topPerformer = monthArr.length > 0
      ? monthArr.reduce((a, b) => a.total_hours > b.total_hours ? a : b)
      : null;
    const mostLeaves = monthArr.length > 0
      ? monthArr.reduce((a, b) => a.total_leaves > b.total_leaves ? a : b)
      : null;

    return res.json({
      tasks_by_status,
      tasks_by_priority,
      tasks_per_person: perPersonResult.rows,
      stagnant_count,
      attendance_summary,
      avg_drift_days: driftCount > 0 ? Math.round((totalDrift / driftCount) * 10) / 10 : 0,
      attendance_overview: {
        team_avg_hours_today: teamPresentToday > 0 ? Math.round((todayTotalHours / teamPresentToday) * 100) / 100 : 0,
        team_present_today: teamPresentToday,
        team_on_leave_today: teamOnLeaveToday,
        team_late_today: teamLateToday,
        top_performer_this_month: topPerformer ? { user_name: topPerformer.user_name, total_hours: Math.round(topPerformer.total_hours * 100) / 100 } : null,
        most_leaves_this_month: mostLeaves && mostLeaves.total_leaves > 0 ? { user_name: mostLeaves.user_name, total_leaves: mostLeaves.total_leaves } : null,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate dashboard' });
  }
}

module.exports = { dashboard };
