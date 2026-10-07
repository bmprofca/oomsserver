import "dotenv/config";
import pool from "../../db.js";

async function addColumnIfMissing(name, definition) {
    const [rows] = await pool.query(
        `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'in_app_voice_calls'
           AND COLUMN_NAME = ?
         LIMIT 1`,
        [name]
    );
    if (!rows.length) {
        await pool.query(`ALTER TABLE in_app_voice_calls ADD COLUMN ${definition}`);
    }
}

async function addIndexIfMissing(name, columns) {
    const [rows] = await pool.query(
        `SELECT INDEX_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'in_app_voice_calls'
           AND INDEX_NAME = ?
         LIMIT 1`,
        [name]
    );
    if (!rows.length) {
        await pool.query(`CREATE INDEX ${name} ON in_app_voice_calls (${columns})`);
    }
}

try {
    await addColumnIfMissing(
        "initiated_by",
        "`initiated_by` ENUM('staff', 'client') NOT NULL DEFAULT 'staff' AFTER `client_name`"
    );
    await addColumnIfMissing(
        "recipient_panel",
        "`recipient_panel` ENUM('client', 'ca', 'enduser') NOT NULL DEFAULT 'client' AFTER `initiated_by`"
    );
    await addColumnIfMissing(
        "accepted_by_session_hash",
        "`accepted_by_session_hash` CHAR(64) NULL AFTER `recipient_panel`"
    );
    await addIndexIfMissing(
        "idx_in_app_voice_client_incoming",
        "`client_username`, `initiated_by`, `recipient_panel`, `status`, `expires_at`"
    );
    await addIndexIfMissing(
        "idx_in_app_voice_staff_incoming",
        "`caller_username`, `initiated_by`, `recipient_panel`, `status`, `expires_at`"
    );
    console.log("Verified in-app voice-call direction columns and indexes.");
} catch (error) {
    console.error("Failed to migrate in-app voice-call directions:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
