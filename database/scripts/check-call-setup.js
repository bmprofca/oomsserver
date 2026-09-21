import pool from '../../db.js';

const branch_id = '123456';
const [cfg] = await pool.query(
  `SELECT config_id, status, LENGTH(api_key_encrypted) AS key_len FROM call_branch_configs WHERE branch_id = ?`,
  [branch_id]
);
console.log('branch config', cfg);

const [staff] = await pool.query(
  `SELECT username, type, status, call_extension FROM branch_mapping
   WHERE branch_id = ? AND is_deleted = '0' AND status = '1'
   ORDER BY id DESC LIMIT 10`,
  [branch_id]
);
console.log('staff', staff);

const [sys] = await pool.query(
  `SELECT api_base_url, status FROM call_system_pbx_config ORDER BY id DESC LIMIT 1`
);
console.log('system', sys);
await pool.end();
