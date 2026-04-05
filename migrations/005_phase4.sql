-- 005_phase4.sql
-- Task Pause/Resume, Idea Bank, Stagnant Detection, Archive, Reorder

-- 1. Add pause_reason enum
CREATE TYPE pause_reason AS ENUM ('priority_shift', 'blocked', 'need_info', 'other');

-- 2. Extend task_status enum
ALTER TYPE task_status ADD VALUE 'idea';
ALTER TYPE task_status ADD VALUE 'archived';

-- 3. Add columns to ops_tasks
ALTER TABLE ops_tasks
  ADD COLUMN date_set_by UUID REFERENCES ops_users(id),
  ADD COLUMN completed_at DATE,
  ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT false;

-- 4. Create ops_task_pauses table
CREATE TABLE ops_task_pauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
  paused_by UUID NOT NULL REFERENCES ops_users(id),
  paused_at DATE NOT NULL DEFAULT CURRENT_DATE,
  resumed_at DATE,
  reason pause_reason NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create ops_idea_requests table
CREATE TABLE ops_idea_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES ops_users(id),
  reviewed_by UUID REFERENCES ops_users(id),
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
