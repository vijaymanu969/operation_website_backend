-- 009_pause_request_message.sql
-- Add pause_request message type and pause_request_id column to ops_messages

ALTER TYPE message_type ADD VALUE 'pause_request';

ALTER TABLE ops_messages
  ADD COLUMN IF NOT EXISTS pause_request_id UUID REFERENCES ops_task_pause_requests(id) ON DELETE SET NULL;
