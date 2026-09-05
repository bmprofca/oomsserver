import pool from "../db.js";

const sql = `
ALTER TABLE tasks
  ADD COLUMN ca_approval ENUM('pending','sent','complete') NOT NULL DEFAULT 'pending' AFTER ca_id,
  ADD COLUMN udin VARCHAR(100) NULL DEFAULT NULL AFTER ca_approval
`;

try {
    await pool.query(sql);
    console.log("Migration OK: ca_approval + udin added");
} catch (e) {
    if (e.code === "ER_DUP_FIELDNAME") {
        console.log("Columns already exist — skipped");
    } else {
        console.error(e.message);
        process.exitCode = 1;
    }
} finally {
    await pool.end().catch(() => {});
}
