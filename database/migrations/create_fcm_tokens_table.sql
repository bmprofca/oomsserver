-- FCM Push Notification Tokens
-- Run once against your database to enable push notifications.
-- This table stores one FCM token per (username, panel, device_id) combination.

CREATE TABLE IF NOT EXISTS fcm_tokens (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username    VARCHAR(100)                          NOT NULL,
    panel       ENUM('enduser', 'client', 'ca')      NOT NULL DEFAULT 'enduser',
    fcm_token   TEXT                                  NOT NULL,
    device_id   VARCHAR(255)                          DEFAULT NULL COMMENT 'Platform device identifier for upsert deduplication',
    created_at  TIMESTAMP                             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP                             NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Fast lookup by username (used when sending push to a user)
    INDEX idx_fcm_username_panel (username, panel),
    -- Unique constraint: one token per device per panel per user
    UNIQUE KEY uq_fcm_device (username, panel, device_id(190))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
