import pool from '../../db.js';

const [rows] = await pool.query(
  `SELECT branch_id, call_channel FROM branch_list WHERE is_deleted = '0' LIMIT 5`
);
console.log(rows);
await pool.end();
