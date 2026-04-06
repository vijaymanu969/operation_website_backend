-- 008_pause_requests.sql
-- Pause requests require reviewer approval before a task is actually paused

CREATE TABLE ops_task_pause_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES ops_users(id),
  reviewed_by  UUID REFERENCES ops_users(id),
  status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reason       pause_reason NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at  TIMESTAMPTZ
);
