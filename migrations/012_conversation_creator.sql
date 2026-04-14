-- 012_conversation_creator.sql
-- Track who created each group conversation for member management permissions

ALTER TABLE ops_conversations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES ops_users(id) ON DELETE SET NULL;
