require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'ops_%'
     ORDER BY table_name`
  );
  console.log('\n=== TABLES ===');
  tables.rows.forEach(r => console.log(' ', r.table_name));

  const userCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'ops_users' ORDER BY ordinal_position`
  );
  console.log('\n=== ops_users columns ===');
  userCols.rows.forEach(r => console.log(' ', r.column_name));

  const taskCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'ops_tasks' ORDER BY ordinal_position`
  );
  console.log('\n=== ops_tasks columns ===');
  taskCols.rows.forEach(r => console.log(' ', r.column_name));

  await pool.end();
}

check().catch(e => { console.error(e); process.exit(1); });
