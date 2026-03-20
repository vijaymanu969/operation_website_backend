CREATE TABLE review_workflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id VARCHAR(255) NOT NULL,
  assignee_id UUID NOT NULL,
  reviewer_id UUID NOT NULL,
  status VARCHAR(30) DEFAULT 'assigned',
  submitted_at TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewer_note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- status values: assigned → in_progress → submitted → approved → rejected
