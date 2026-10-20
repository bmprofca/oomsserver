/**
 * AI assistant tables. Created on first use (CREATE TABLE IF NOT EXISTS), the same way
 * helpers/razorpayConfig.js does, so no manual migration step is required.
 * database/migrations/20261020_ai_assistant.sql mirrors these statements.
 */
export const AI_TABLE_DDL = [
    // Branch-level switch and rate limits. provider/model/effort/api_key_* are legacy
    // (single-key era): migrated into branch_ai_connections on first use, then cleared.
    `CREATE TABLE IF NOT EXISTS branch_ai_settings (
        id INT NOT NULL AUTO_INCREMENT,
        branch_id VARCHAR(50) NOT NULL,
        enabled ENUM('0','1') NOT NULL DEFAULT '0',
        provider VARCHAR(30) NOT NULL DEFAULT 'anthropic',
        model VARCHAR(80) NOT NULL DEFAULT 'claude-sonnet-5-5',
        effort VARCHAR(10) NOT NULL DEFAULT 'medium',
        api_key_enc TEXT NULL,
        api_key_hint VARCHAR(16) NULL,
        rate_per_min INT NOT NULL DEFAULT 6,
        rate_per_day INT NOT NULL DEFAULT 200,
        access_mode VARCHAR(20) NOT NULL DEFAULT 'read',
        create_by VARCHAR(100) NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modify_by VARCHAR(100) NULL,
        modify_date DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_branch_ai_settings_branch (branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    // One row per saved AI connection (provider + key + model). Enabled rows are tried in
    // priority order; the first that works answers (failover). Keys are AES-256-GCM encrypted.
    `CREATE TABLE IF NOT EXISTS branch_ai_connections (
        id INT NOT NULL AUTO_INCREMENT,
        connection_id VARCHAR(40) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        label VARCHAR(80) NULL,
        provider VARCHAR(30) NOT NULL,
        model VARCHAR(100) NOT NULL,
        effort VARCHAR(10) NOT NULL DEFAULT 'medium',
        api_key_enc TEXT NOT NULL,
        api_key_hint VARCHAR(16) NULL,
        enabled ENUM('0','1') NOT NULL DEFAULT '1',
        priority INT NOT NULL DEFAULT 0,
        last_status VARCHAR(40) NULL,
        last_checked_at DATETIME NULL,
        last_used_at DATETIME NULL,
        create_by VARCHAR(100) NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modify_by VARCHAR(100) NULL,
        modify_date DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_branch_ai_connection_id (connection_id),
        KEY idx_branch_ai_connections_branch (branch_id, priority)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    // Remote MCP connectors (e.g. Claude → Settings → Connectors → Add custom connector).
    // Each connector URL carries a secret; only its SHA-256 hash is stored. Requests run
    // with the permissions of `run_as_username` in this branch, read-only.
    `CREATE TABLE IF NOT EXISTS branch_mcp_connectors (
        id INT NOT NULL AUTO_INCREMENT,
        connector_id VARCHAR(40) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        label VARCHAR(80) NULL,
        token_hash CHAR(64) NOT NULL,
        token_hint VARCHAR(16) NULL,
        run_as_username VARCHAR(100) NOT NULL,
        enabled ENUM('0','1') NOT NULL DEFAULT '1',
        access_mode VARCHAR(20) NOT NULL DEFAULT 'read',
        last_used_at DATETIME NULL,
        last_client VARCHAR(120) NULL,
        create_by VARCHAR(100) NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modify_by VARCHAR(100) NULL,
        modify_date DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_branch_mcp_connector_id (connector_id),
        UNIQUE KEY uq_branch_mcp_token_hash (token_hash),
        KEY idx_branch_mcp_connectors_branch (branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    // Write actions proposed by the AI (send WhatsApp / email, share documents). Nothing is
    // executed until a person confirms: the chat card (in-app) or confirm_action (connector).
    `CREATE TABLE IF NOT EXISTS ai_pending_actions (
        id BIGINT NOT NULL AUTO_INCREMENT,
        action_id VARCHAR(40) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        source VARCHAR(60) NOT NULL,
        action_type VARCHAR(40) NOT NULL,
        payload JSON NOT NULL,
        preview JSON NOT NULL,
        status ENUM('pending','executing','done','partial','failed','cancelled','expired') NOT NULL DEFAULT 'pending',
        result JSON NULL,
        expires_at DATETIME NOT NULL,
        decided_at DATETIME NULL,
        decided_by VARCHAR(100) NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ai_pending_action_id (action_id),
        KEY idx_ai_pending_owner (branch_id, username, status, create_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_conversations (
        id BIGINT NOT NULL AUTO_INCREMENT,
        conversation_id VARCHAR(40) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        title VARCHAR(200) NULL,
        message_count INT NOT NULL DEFAULT 0,
        last_message_at DATETIME NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modify_date DATETIME NULL,
        is_deleted ENUM('0','1') NOT NULL DEFAULT '0',
        PRIMARY KEY (id),
        UNIQUE KEY uq_ai_conversation_id (conversation_id),
        KEY idx_ai_conv_owner (branch_id, username, is_deleted, last_message_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_messages (
        id BIGINT NOT NULL AUTO_INCREMENT,
        message_id VARCHAR(40) NOT NULL,
        conversation_id VARCHAR(40) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        role ENUM('user','assistant') NOT NULL,
        content MEDIUMTEXT NULL,
        blocks JSON NULL,
        tool_calls JSON NULL,
        status ENUM('ok','partial','clarification','refusal','error') NOT NULL DEFAULT 'ok',
        model VARCHAR(80) NULL,
        input_tokens INT NULL,
        output_tokens INT NULL,
        correlation_id VARCHAR(40) NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ai_message_id (message_id),
        KEY idx_ai_msg_conv (conversation_id, id),
        KEY idx_ai_msg_branch (branch_id, create_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_tool_calls (
        id BIGINT NOT NULL AUTO_INCREMENT,
        conversation_id VARCHAR(40) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        tool_name VARCHAR(80) NOT NULL,
        args JSON NULL,
        status ENUM('ok','denied','invalid','error','timeout') NOT NULL,
        row_count INT NULL,
        duration_ms INT NULL,
        error_code VARCHAR(60) NULL,
        correlation_id VARCHAR(40) NULL,
        create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_ai_tool_branch (branch_id, create_date),
        KEY idx_ai_tool_conv (conversation_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/**
 * Columns added after a table may already exist in production (CREATE TABLE IF NOT EXISTS
 * does not alter existing tables). Each is added once if missing.
 */
export const AI_COLUMN_MIGRATIONS = [
    { table: "branch_ai_settings", column: "access_mode", ddl: "ALTER TABLE branch_ai_settings ADD COLUMN access_mode VARCHAR(20) NOT NULL DEFAULT 'read' AFTER rate_per_day" },
    { table: "branch_mcp_connectors", column: "access_mode", ddl: "ALTER TABLE branch_mcp_connectors ADD COLUMN access_mode VARCHAR(20) NOT NULL DEFAULT 'read' AFTER enabled" },
];

async function ensureColumns(db) {
    for (const m of AI_COLUMN_MIGRATIONS) {
        const [rows] = await db.query(
            "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
            [m.table, m.column]
        );
        if (Number(rows?.[0]?.n) > 0) continue;
        try {
            await db.query(m.ddl);
        } catch (err) {
            if (err?.code !== "ER_DUP_FIELDNAME") throw err; // another process added it first
        }
    }
}

const ensured = new WeakMap();

/** Create the AI tables once per db handle; retried on the next call if it fails. */
export function ensureAiTables(db) {
    let p = ensured.get(db);
    if (!p) {
        p = (async () => {
            for (const ddl of AI_TABLE_DDL) await db.query(ddl);
            await ensureColumns(db);
        })().catch((err) => {
            ensured.delete(db);
            throw err;
        });
        ensured.set(db, p);
    }
    return p;
}
