-- 013_task_created_message_type.sql
-- Add task_created message type for chat notifications when a task is created

ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'task_created';
