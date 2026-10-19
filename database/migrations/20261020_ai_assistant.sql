-- AI assistant: per-branch settings, AI connections (failover), chat history and tool-call audit log.
-- The server also creates these tables automatically on first use (ai/schema.js).
-- Idempotent. Every row is scoped by branch_id (+ username); tool result rows are never stored.
-- Keep in sync with ai/schema.js.

CREATE TABLE IF NOT EXISTS branch_ai_settings (
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
    create_by VARCHAR(100) NULL,
    create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modify_by VARCHAR(100) NULL,
    modify_date DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_branch_ai_settings_branch (branch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS branch_ai_connections (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_conversations (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_messages (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_tool_calls (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
