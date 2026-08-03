import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATEMENTS = [
  "ALTER TABLE attendance ADD COLUMN expected_hours DECIMAL(5,2) NULL COMMENT 'Snapshot from staff_salaries for this mark' AFTER out_time",
  "ALTER TABLE attendance ADD COLUMN worked_minutes INT NULL COMMENT 'Punch duration in minutes' AFTER expected_hours",
  "ALTER TABLE attendance ADD COLUMN extra_minutes INT NULL DEFAULT 0 COMMENT 'Minutes over expected_hours' AFTER worked_minutes",
  "ALTER TABLE attendance ADD COLUMN less_minutes INT NULL DEFAULT 0 COMMENT 'Minutes under expected_hours' AFTER extra_minutes",
  "ALTER TABLE attendance ADD COLUMN overtime_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = OT amount applied' AFTER less_minutes",
  "ALTER TABLE attendance ADD COLUMN fine_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = fine amount applied' AFTER overtime_enabled",
  "ALTER TABLE attendance ADD COLUMN daily_wage DECIMAL(12,2) NULL COMMENT 'Monthly amount / days in month' AFTER fine_enabled",
  "ALTER TABLE attendance ADD COLUMN overtime_amount DECIMAL(12,2) NULL DEFAULT 0.00 AFTER daily_wage",
  "ALTER TABLE attendance ADD COLUMN fine_amount DECIMAL(12,2) NULL DEFAULT 0.00 AFTER overtime_amount",
  "ALTER TABLE attendance ADD COLUMN net_day_amount DECIMAL(12,2) NULL COMMENT 'daily_wage + overtime_amount - fine_amount' AFTER fine_amount",
];

async function columnExists(conn, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance'
       AND COLUMN_NAME = ?`,
    [column]
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

async function main() {
  const conn = await pool.getConnection();
  try {
    for (const sql of STATEMENTS) {
      const col = sql.match(/ADD COLUMN (\w+)/)?.[1];
      if (col && (await columnExists(conn, col))) {
        console.log(`SKIP: ${col} already exists`);
        continue;
      }
      try {
        await conn.query(sql);
        console.log(`OK: ${col}`);
      } catch (error) {
        if (error?.code === "ER_DUP_FIELDNAME") {
          console.log(`SKIP: ${col} duplicate`);
          continue;
        }
        throw error;
      }
    }
    console.log("Attendance OT/fine columns ready.");
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
