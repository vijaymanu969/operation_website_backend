-- 007_activity_log.sql
-- Add is_system flag to ops_task_comments so status/pause changes appear as activity log entries

ALTER TABLE ops_task_comments ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
