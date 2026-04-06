-- 005_user_color.sql
-- Add a color field to users for UI display (shown on task cards, chat, etc.)

ALTER TABLE ops_users ADD COLUMN color TEXT NOT NULL DEFAULT 'gray';
