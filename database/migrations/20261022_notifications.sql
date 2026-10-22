-- Unified, branch-scoped in-app notification contract.
-- Rollback: archive/export these tables, then drop `notification_preferences`
-- and `notifications` only after all consumers have been disabled.

CREATE TABLE IF NOT EXISTS `notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `notification_id` VARCHAR(96) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `recipient_type` VARCHAR(32) NOT NULL,
  `recipient_id` VARCHAR(100) NOT NULL,
  `event_key` VARCHAR(191) NOT NULL,
  `category` VARCHAR(64) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `body` TEXT NOT NULL,
  `data_json` JSON NULL,
  `delivery_status` ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'sent',
  `read_at` DATETIME NULL DEFAULT NULL,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `expires_at` DATETIME NULL DEFAULT NULL,
  `actor_username` VARCHAR(100) NULL DEFAULT NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notifications_id` (`notification_id`),
  UNIQUE KEY `uq_notifications_recipient_event` (`branch_id`, `recipient_type`, `recipient_id`, `event_key`),
  KEY `idx_notifications_recipient_unread` (`branch_id`, `recipient_type`, `recipient_id`, `read_at`, `deleted_at`, `create_date`),
  KEY `idx_notifications_branch_category` (`branch_id`, `category`, `create_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notification_preferences` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `branch_id` VARCHAR(50) NOT NULL,
  `recipient_type` VARCHAR(32) NOT NULL,
  `recipient_id` VARCHAR(100) NOT NULL,
  `category` VARCHAR(64) NOT NULL,
  `in_app_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `push_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `email_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `sms_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `modify_by` VARCHAR(100) NULL DEFAULT NULL,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notification_preferences_recipient_category` (`branch_id`, `recipient_type`, `recipient_id`, `category`),
  KEY `idx_notification_preferences_recipient` (`branch_id`, `recipient_type`, `recipient_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
