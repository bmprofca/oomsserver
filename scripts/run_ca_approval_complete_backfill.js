/**
 * Backfill ca_approval = 'complete' for tasks already marked status = complete.
 * New CA approval / UDIN flow is for pending (non-complete) work only.
 */
import pool from "../db.js";

const sql = `
UPDATE tasks
SET ca_approval = 'complete'
WHERE LOWER(TRIM(status)) = 'complete'
  AND has_ca = '1'
  AND (ca_approval IS NULL OR ca_approval <> 'complete')
`;

try {
    const [result] = await pool.query(sql);
    const affected = result?.affectedRows ?? 0;
    console.log(`Backfill OK: ca_approval set to complete for ${affected} completed task(s)`);
} catch (e) {
    console.error("Backfill failed:", e.message);
    process.exitCode = 1;
} finally {
    await pool.end().catch(() => {});
}
