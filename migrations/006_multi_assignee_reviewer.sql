-- 006_multi_assignee_reviewer.sql
-- Support multiple assignees (people) and multiple reviewers (captains) per task

-- 1. Junction table for task assignees (people working on the task)
CREATE TABLE ops_task_assignees (
  task_id UUID NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- 2. Junction table for task reviewers (captains)
CREATE TABLE ops_task_reviewers (
  task_id UUID NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- 3. Migrate existing data from person_id and reviewer_id into junction tables
INSERT INTO ops_task_assignees (task_id, user_id)
  SELECT id, person_id FROM ops_tasks WHERE person_id IS NOT NULL
  ON CONFLICT DO NOTHING;

INSERT INTO ops_task_reviewers (task_id, user_id)
  SELECT id, reviewer_id FROM ops_tasks WHERE reviewer_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- 4. Drop old single columns (no longer needed)
ALTER TABLE ops_tasks DROP COLUMN person_id;
ALTER TABLE ops_tasks DROP COLUMN reviewer_id;
