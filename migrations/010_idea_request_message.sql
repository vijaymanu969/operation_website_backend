-- 010_idea_request_message.sql
-- Add idea_request message type and idea_request_id column to ops_messages

ALTER TYPE message_type ADD VALUE 'idea_request';

ALTER TABLE ops_messages
  ADD COLUMN IF NOT EXISTS idea_request_id UUID REFERENCES ops_idea_requests(id) ON DELETE SET NULL;
