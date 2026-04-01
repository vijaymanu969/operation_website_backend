const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, name, email, password_hash, role FROM ops_users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.GOTRUE_JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed' });
  }
}

async function getMe(req, res) {
  try {
    const userResult = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM ops_users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accessResult = await pool.query(
      'SELECT page_name, permission FROM ops_page_access WHERE user_id = $1',
      [req.user.id]
    );

    const user = userResult.rows[0];
    user.page_access = accessResult.rows;

    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
}

async function changePassword(req, res) {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      return res.status(400).json({ error: 'Old and new passwords are required' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const result = await pool.query(
      'SELECT password_hash FROM ops_users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(old_password, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Old password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE ops_users SET password_hash = $1 WHERE id = $2',
      [hash, req.user.id]
    );

    return res.json({ message: 'Password changed successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to change password' });
  }
}

module.exports = { login, getMe, changePassword };
