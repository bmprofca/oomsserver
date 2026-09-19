import pool from '../../db.js';

const [result] = await pool.query(
  `UPDATE call_branch_configs SET status = 'active' WHERE branch_id = '123456'`
);
console.log('activated rows', result.affectedRows);
await pool.end();
