const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: 'postgres://postgres:admin@localhost:6666/ops_backend',
});

async function fix() {
  const hash = await bcrypt.hash('changeme', 10);
  const result = await pool.query(
    'UPDATE ops_users SET password_hash = $1 WHERE email = $2 RETURNING id, name, email, role',
    [hash, 'admin@celume.com']
  );
  console.log('Updated:', result.rows[0]);
  await pool.end();
}

fix().catch(err => { console.error(err); process.exit(1); });
