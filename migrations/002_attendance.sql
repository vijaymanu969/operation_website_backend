-- 002_attendance.sql
-- Attendance tracking with raw_value parsing support

CREATE TABLE ops_attendance (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  raw_value   TEXT NOT NULL DEFAULT '',
  is_leave    BOOLEAN NOT NULL DEFAULT false,
  leave_type  TEXT,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
);

CREATE TRIGGER update_ops_attendance_updated_at
  BEFORE UPDATE ON ops_attendance
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column_func();
