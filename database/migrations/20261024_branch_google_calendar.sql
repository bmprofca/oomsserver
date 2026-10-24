CREATE TABLE IF NOT EXISTS `branch_google_calendar_connections` (
  `connection_id` VARCHAR(48) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `refresh_token_encrypted` TEXT NOT NULL,
  `calendar_id` VARCHAR(255) NOT NULL DEFAULT 'primary',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` VARCHAR(100) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `connected_at` DATETIME NOT NULL,
  `last_tested_at` DATETIME NULL,
  PRIMARY KEY (`connection_id`),
  KEY `idx_branch_google_calendar_active` (`branch_id`, `is_active`, `connected_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `branch_google_calendar_oauth_states` (
  `state_hash` CHAR(64) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `calendar_id` VARCHAR(255) NOT NULL DEFAULT 'primary',
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`state_hash`),
  KEY `idx_branch_google_calendar_state_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `appointments`
  ADD COLUMN `google_calendar_connection_id` VARCHAR(48) NULL DEFAULT NULL
  AFTER `google_event_id`;

UPDATE `appointments`
SET `google_calendar_connection_id` = 'legacy'
WHERE `google_calendar_connection_id` IS NULL;

ALTER TABLE `appointments`
  ADD KEY `idx_appointments_google_calendar_connection` (`google_calendar_connection_id`);
