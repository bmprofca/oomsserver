import "dotenv/config";
import pool from "../../db.js";

async function columnExists(conn, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'staff_salaries'
       AND COLUMN_NAME = ?`,
    [column]
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

async function addColumn(conn, sql, name) {
  if (await columnExists(conn, name)) {
    console.log(`SKIP add: ${name}`);
    return;
  }
  await conn.query(sql);
  console.log(`OK add: ${name}`);
}

async function dropColumn(conn, name) {
  if (!(await columnExists(conn, name))) {
    console.log(`SKIP drop: ${name}`);
    return;
  }
  await conn.query(`ALTER TABLE staff_salaries DROP COLUMN \`${name}\``);
  console.log(`OK drop: ${name}`);
}

async function main() {
  const conn = await pool.getConnection();
  try {
    await addColumn(
      conn,
      `ALTER TABLE staff_salaries
       ADD COLUMN expected_minutes INT NULL COMMENT 'Fixed: expected daily work minutes' AFTER working_hours_end`,
      "expected_minutes"
    );
    await addColumn(
      conn,
      `ALTER TABLE staff_salaries
       ADD COLUMN monthly_working_minutes INT NULL COMMENT 'Flexible: monthly work minutes' AFTER expected_minutes`,
      "monthly_working_minutes"
    );

    if (await columnExists(conn, "expected_hours")) {
      await conn.query(
        `UPDATE staff_salaries
         SET expected_minutes = CASE
           WHEN expected_hours IS NULL THEN expected_minutes
           ELSE ROUND(expected_hours * 60)
         END
         WHERE expected_minutes IS NULL`
      );
      console.log("OK backfill: expected_minutes");
    }
    if (await columnExists(conn, "monthly_working_hours")) {
      await conn.query(
        `UPDATE staff_salaries
         SET monthly_working_minutes = CASE
           WHEN monthly_working_hours IS NULL THEN monthly_working_minutes
           ELSE ROUND(monthly_working_hours * 60)
         END
         WHERE monthly_working_minutes IS NULL`
      );
      console.log("OK backfill: monthly_working_minutes");
    }

    for (const col of [
      "monthly_working_hours",
      "expected_hours",
      "overtime_rate_type",
      "fine_rate_type",
      "break_excess_penalty_type",
      "break_excess_penalty_value",
      "travel_allowance_type",
      "travel_allowance_value",
      "other_deduction_type",
      "other_deduction_value",
    ]) {
      await dropColumn(conn, col);
    }

    const [cols] = await conn.query("SHOW COLUMNS FROM staff_salaries");
    console.log("staff_salaries columns:", cols.map((c) => c.Field).join(", "));
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
