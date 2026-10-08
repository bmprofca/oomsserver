import "dotenv/config";
import pool from "../../db.js";

try {
    const [rows] = await pool.query(
        `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'in_app_voice_calls'
           AND COLUMN_NAME = 'connected_at'
         LIMIT 1`
    );
    if (!rows.length) {
        await pool.query(
            "ALTER TABLE in_app_voice_calls ADD COLUMN connected_at DATETIME NULL AFTER accepted_at"
        );
    }
    console.log("Verified in-app voice-call connection tracking.");
} catch (error) {
    console.error("Failed to migrate in-app voice-call connection tracking:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
