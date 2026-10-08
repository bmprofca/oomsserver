import "dotenv/config";
import pool from "../../db.js";

try {
    await pool.query(
        `CREATE TABLE IF NOT EXISTS in_app_voice_call_sessions (
            call_id CHAR(36) NOT NULL,
            session_id VARCHAR(180) NOT NULL,
            status ENUM('ringing', 'declined') NOT NULL DEFAULT 'ringing',
            create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            modify_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (call_id, session_id),
            KEY idx_in_app_voice_call_sessions_status (call_id, status),
            CONSTRAINT fk_in_app_voice_call_sessions_call
                FOREIGN KEY (call_id) REFERENCES in_app_voice_calls (call_id)
                ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    console.log("Verified in-app voice-call session response table.");
} catch (error) {
    console.error("Failed to migrate in-app voice-call sessions:", error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
