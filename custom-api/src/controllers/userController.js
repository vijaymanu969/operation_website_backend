const bcrypt = require('bcryptjs');
const pool = require('../db');

const ADMIN_MANAGED_ROLES = ['worker', 'intern'];

async function listUsers(req, res) {
  try {
    const { role, is_active } = req.query;
    let query = 'SELECT id, name, email, role, is_active, created_at, updated_at FROM ops_users WHERE 1=1';
    const params = [];

    // admin can only see workers and interns
    if (req.user.role === 'admin') {
      query += ` AND role IN ('worker', 'intern')`;
    }

    if (role) {
      params.push(role);
      query += ` AND role = $${params.length}`;
    }

    if (is_active !== undefined) {
      params.push(is_active === 'true');
      query += ` AND is_active = $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list users' });
  }
}

async function createUser(req, res) {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const userRole = role || 'intern';

    // admin can only create workers/interns
    if (req.user.role === 'admin' && !ADMIN_MANAGED_ROLES.includes(userRole)) {
      return res.status(403).json({ error: 'Admins can only create worker or intern accounts' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO ops_users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active, created_at`,
      [name, email, hash, userRole]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    return res.status(500).json({ error: 'Failed to create user' });
  }
}

async function getUser(req, res) {
  try {
    const { id } = req.params;

    const userResult = await pool.query(
      'SELECT id, name, email, role, is_active, created_at, updated_at FROM ops_users WHERE id = $1',
      [id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // admin can only see workers/interns
    if (req.user.role === 'admin' && !ADMIN_MANAGED_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const accessResult = await pool.query(
      'SELECT page_name, permission FROM ops_page_access WHERE user_id = $1',
      [id]
    );
    user.page_access = accessResult.rows;

    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { name, email, role, is_active } = req.body;

    // Fetch target user
    const existing = await pool.query('SELECT role FROM ops_users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // admin can only edit workers/interns
    if (req.user.role === 'admin') {
      if (!ADMIN_MANAGED_ROLES.includes(existing.rows[0].role)) {
        return res.status(403).json({ error: 'Admins can only edit worker or intern accounts' });
      }
      if (role && !ADMIN_MANAGED_ROLES.includes(role)) {
        return res.status(403).json({ error: 'Admins can only assign worker or intern roles' });
      }
    }

    // Cannot change own role
    if (id === req.user.id && role && role !== req.user.role) {
      return res.status(403).json({ error: 'Cannot change your own role' });
    }

    const fields = [];
    const params = [];

    if (name !== undefined) { params.push(name); fields.push(`name = $${params.length}`); }
    if (email !== undefined) { params.push(email); fields.push(`email = $${params.length}`); }
    if (role !== undefined) { params.push(role); fields.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); fields.push(`is_active = $${params.length}`); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE ops_users SET ${fields.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, email, role, is_active, created_at, updated_at`,
      params
    );

    return res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    return res.status(500).json({ error: 'Failed to update user' });
  }
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(403).json({ error: 'Cannot delete yourself' });
    }

    const result = await pool.query(
      `UPDATE ops_users SET is_active = false WHERE id = $1
       RETURNING id, name, email, role, is_active`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ message: 'User deactivated', user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete user' });
  }
}

async function getAccess(req, res) {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT page_name, permission FROM ops_page_access WHERE user_id = $1 ORDER BY page_name',
      [id]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch access' });
  }
}

async function setAccess(req, res) {
  try {
    const { id } = req.params;
    const { pages } = req.body;

    if (!Array.isArray(pages)) {
      return res.status(400).json({ error: 'pages must be an array of {page_name, permission}' });
    }

    // Check target user exists
    const target = await pool.query('SELECT role FROM ops_users WHERE id = $1', [id]);
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // admin can only set access for workers/interns
    if (req.user.role === 'admin' && !ADMIN_MANAGED_ROLES.includes(target.rows[0].role)) {
      return res.status(403).json({ error: 'Admins can only set access for worker or intern accounts' });
    }

    // admin can only grant access to pages they themselves have access to
    if (req.user.role === 'admin') {
      const ownAccess = await pool.query(
        'SELECT page_name FROM ops_page_access WHERE user_id = $1',
        [req.user.id]
      );
      const ownPages = new Set(ownAccess.rows.map(r => r.page_name));
      const unauthorized = pages.filter(p => !ownPages.has(p.page_name));
      if (unauthorized.length > 0) {
        return res.status(403).json({
          error: 'Cannot grant access to pages you do not have access to',
          pages: unauthorized.map(p => p.page_name),
        });
      }
    }

    // Delete existing and insert new
    await pool.query('DELETE FROM ops_page_access WHERE user_id = $1', [id]);

    for (const page of pages) {
      await pool.query(
        'INSERT INTO ops_page_access (user_id, page_name, permission) VALUES ($1, $2, $3)',
        [id, page.page_name, page.permission || 'view']
      );
    }

    const result = await pool.query(
      'SELECT page_name, permission FROM ops_page_access WHERE user_id = $1 ORDER BY page_name',
      [id]
    );

    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to set access' });
  }
}

module.exports = { listUsers, createUser, getUser, updateUser, deleteUser, getAccess, setAccess };
