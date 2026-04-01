-- 001_users.sql
-- Creates the core user and page-access tables for Celume Ops

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Reusable trigger function: auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at_column_func()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Role enum
CREATE TYPE user_role AS ENUM ('super_admin', 'admin', 'worker', 'intern');

-- Page-level permission enum
CREATE TYPE page_permission AS ENUM ('view', 'edit');

-- Users table
CREATE TABLE ops_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'intern',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Auto-update updated_at on ops_users
CREATE TRIGGER update_ops_users_updated_at
  BEFORE UPDATE ON ops_users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column_func();

-- Page access control
CREATE TABLE ops_page_access (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  page_name TEXT NOT NULL,
  permission page_permission DEFAULT 'view',
  UNIQUE(user_id, page_name)
);

-- Seed super_admin user (password: changeme)
INSERT INTO ops_users (name, email, password_hash, role)
VALUES (
  'Super Admin',
  'admin@celume.com',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
  'super_admin'
);
