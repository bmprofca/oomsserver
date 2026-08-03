import pool from "../../db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, "../migrations/20260802_payslip_entries.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

const conn = await pool.getConnection();
try {
  await conn.query(sql);
  const [cols] = await conn.query("SHOW COLUMNS FROM payslip_entries");
  console.log("OK payslip_entries:", cols.map((c) => c.Field).join(", "));
} finally {
  conn.release();
  process.exit(0);
}
