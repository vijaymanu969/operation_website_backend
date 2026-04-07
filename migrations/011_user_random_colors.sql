-- 011_user_random_colors.sql
-- Replace default 'gray' user color with random soothing colors
-- Keep super_admin('gray') as is? No — assign all gray users a real color.

DO $$
DECLARE
  user_record RECORD;
  colors TEXT[] := ARRAY['blue', 'purple', 'green', 'orange', 'pink', 'teal', 'indigo', 'rose'];
  picked TEXT;
BEGIN
  FOR user_record IN SELECT id FROM ops_users WHERE color = 'gray' LOOP
    picked := colors[1 + floor(random() * array_length(colors, 1))::int];
    UPDATE ops_users SET color = picked WHERE id = user_record.id;
  END LOOP;
END $$;

-- Remove the gray default — controller now picks a random color for new users
ALTER TABLE ops_users ALTER COLUMN color DROP DEFAULT;
