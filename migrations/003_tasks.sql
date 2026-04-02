-- 003_tasks.sql
-- Task system with reviewer flow and customizable types

CREATE TYPE task_status AS ENUM ('not_completed', 'reviewer', 'completed');
CREATE TYPE task_priority AS ENUM ('high', 'medium', 'low');

CREATE TABLE ops_tasks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         TEXT NOT NULL,
  description   TEXT DEFAULT '',
  status        task_status NOT NULL DEFAULT 'not_completed',
  priority      task_priority NOT NULL DEFAULT 'medium',
  date          DATE,
  end_date      DATE,
  person_id     UUID REFERENCES ops_users(id),
  reviewer_id   UUID REFERENCES ops_users(id),
  created_by    UUID REFERENCES ops_users(id),
  column_group  TEXT NOT NULL DEFAULT 'todo',
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_ops_tasks_modtime
  BEFORE UPDATE ON ops_tasks
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column_func();

CREATE TABLE ops_task_types (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'gray',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ops_task_type_assignments (
  task_id UUID REFERENCES ops_tasks(id) ON DELETE CASCADE,
  type_id UUID REFERENCES ops_task_types(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, type_id)
);

CREATE TABLE ops_task_comments (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id    UUID NOT NULL REFERENCES ops_tasks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES ops_users(id),
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Seed some default task types (can be changed/deleted via API)
INSERT INTO ops_task_types (name, color) VALUES
  ('prompt', 'purple'),
  ('whatsapp agent', 'pink'),
  ('frontend', 'blue'),
  ('Backend', 'green'),
  ('Agent', 'orange');
