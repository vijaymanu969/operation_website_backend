const pool = require('../db');

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role privileges' });
    }
    next();
  };
}

function requirePageAccess(pageName, permission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // super_admin always has access
    if (req.user.role === 'super_admin') {
      return next();
    }

    try {
      const result = await pool.query(
        'SELECT permission FROM ops_page_access WHERE user_id = $1 AND page_name = $2',
        [req.user.id, pageName]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'No access to this page' });
      }

      const userPerm = result.rows[0].permission;

      // 'edit' includes 'view'
      if (permission === 'view' && (userPerm === 'view' || userPerm === 'edit')) {
        return next();
      }
      if (permission === 'edit' && userPerm === 'edit') {
        return next();
      }

      return res.status(403).json({ error: 'Insufficient page permission' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to check page access' });
    }
  };
}

module.exports = { requireRole, requirePageAccess };
