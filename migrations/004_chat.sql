-- 004_chat.sql
-- Chat system with task review card support

CREATE TYPE conversation_type AS ENUM ('direct', 'group');
CREATE TYPE message_type AS ENUM ('text', 'task_review');
CREATE TYPE review_status AS ENUM ('pending', 'completed', 'rejected');

CREATE TABLE ops_conversations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type       conversation_type NOT NULL DEFAULT 'direct',
  name       TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ops_conversation_members (
  conversation_id UUID NOT NULL REFERENCES ops_conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE ops_messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES ops_conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES ops_users(id),
  type            message_type NOT NULL DEFAULT 'text',
  content         TEXT,
  task_id         UUID REFERENCES ops_tasks(id) ON DELETE SET NULL,
  review_status   review_status,
  created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_ops_messages_modtime
  BEFORE UPDATE ON ops_messages
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column_func();

CREATE INDEX idx_messages_conv_created ON ops_messages (conversation_id, created_at ASC);

-- pg_notify trigger for future real-time WebSocket support
CREATE OR REPLACE FUNCTION notify_new_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('chat_channel', json_build_object(
    'conversation_id', NEW.conversation_id,
    'message_id', NEW.id,
    'sender_id', NEW.sender_id,
    'type', NEW.type
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_notify
  AFTER INSERT ON ops_messages
  FOR EACH ROW EXECUTE FUNCTION notify_new_message();
