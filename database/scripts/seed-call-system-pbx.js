import pool from '../../db.js';
import { UNIQUE_RANDOM_STRING } from '../../helpers/function.js';

const [rows] = await pool.query('SELECT config_id FROM call_system_pbx_config LIMIT 1');
if (!rows.length) {
  const config_id = await UNIQUE_RANDOM_STRING('call_system_pbx_config', 'config_id', { length: 10 });
  await pool.query(
    `INSERT INTO call_system_pbx_config (config_id, api_base_url, status, create_by, modify_by)
     VALUES (?, ?, 'active', 'system', 'system')`,
    [config_id, 'https://ipbx.bmtaxopc.com/api/pbx/calls']
  );
  console.log('Seeded default PBX URL', config_id);
} else {
  console.log('Already configured', rows[0].config_id);
}
await pool.end();
