-- 1. SMS Configurations Table
CREATE TABLE IF NOT EXISTS `sms_configs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `config_id` VARCHAR(50) UNIQUE NOT NULL,
  `branch_id` BIGINT UNSIGNED NOT NULL,
  `config_name` VARCHAR(150) NOT NULL,
  `provider` VARCHAR(50) NOT NULL DEFAULT 'fast2sms',
  `auth_token_encrypted` TEXT NOT NULL,
  `sender_id` VARCHAR(50) DEFAULT '' NULL,
  `route` VARCHAR(20) NOT NULL DEFAULT 'dlt',
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `daily_limit` INT DEFAULT 1000 NULL,
  `sent_today` INT DEFAULT 0 NULL,
  `last_reset_date` DATE NULL,
  `create_by` VARCHAR(100) NULL,
  `modify_by` VARCHAR(100) NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sms_configs_branch_status` (`branch_id`, `status`),
  INDEX `idx_sms_configs_is_default` (`is_default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. SMS Templates Table
CREATE TABLE IF NOT EXISTS `sms_templates` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `template_id` VARCHAR(50) UNIQUE NOT NULL,
  `branch_id` BIGINT UNSIGNED NOT NULL,
  `template_name` VARCHAR(150) NOT NULL,
  `message` VARCHAR(1000) NOT NULL,
  `dlt_template_id` VARCHAR(100) NULL,
  `variables_json` TEXT NULL,
  `status` ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(100) NULL,
  `modify_by` VARCHAR(100) NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sms_templates_branch_id` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. SMS Broadcasts (Campaigns) Table
CREATE TABLE IF NOT EXISTS `sms_broadcasts` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `broadcast_id` VARCHAR(50) UNIQUE NOT NULL,
  `branch_id` BIGINT UNSIGNED NOT NULL,
  `config_id` VARCHAR(50) NOT NULL,
  `fallback_config_id` VARCHAR(50) NULL,
  `template_id` VARCHAR(50) NULL,
  `broadcast_name` VARCHAR(150) NOT NULL,
  `message_snapshot` VARCHAR(1000) NOT NULL,
  `dlt_template_id_snapshot` VARCHAR(100) NULL,
  `template_variables_json` TEXT NULL,
  `global_variables_json` TEXT NULL,
  `schedule_type` ENUM('now','scheduled') NOT NULL DEFAULT 'now',
  `scheduled_at` DATETIME NULL,
  `timezone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
  `status` ENUM('scheduled','processing','completed','partially_failed','failed','cancelled','paused') NOT NULL DEFAULT 'scheduled',
  `total_recipients` INT NOT NULL DEFAULT 0,
  `total_pending` INT NOT NULL DEFAULT 0,
  `total_sent` INT NOT NULL DEFAULT 0,
  `total_failed` INT NOT NULL DEFAULT 0,
  `total_skipped` INT NOT NULL DEFAULT 0,
  `daily_limit` INT DEFAULT 1000 NULL,
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `create_by` VARCHAR(100) NULL,
  `modify_by` VARCHAR(100) NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sms_broadcasts_branch_status` (`branch_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. SMS Broadcast Recipients Table
CREATE TABLE IF NOT EXISTS `sms_broadcast_recipients` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `recipient_id` VARCHAR(50) UNIQUE NOT NULL,
  `broadcast_id` VARCHAR(50) NOT NULL,
  `branch_id` BIGINT UNSIGNED NOT NULL,
  `recipient_name` VARCHAR(255) NULL,
  `recipient_mobile` VARCHAR(20) NOT NULL,
  `variable_values_json` TEXT NULL,
  `status` ENUM('pending','processing','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  `used_config_id` VARCHAR(255) NULL,
  `attempt_count` INT NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `provider_message_id` VARCHAR(255) NULL,
  `sent_at` DATETIME NULL,
  `last_attempt_at` DATETIME NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sms_recipients_branch_id` (`branch_id`),
  INDEX `idx_sms_recipients_broadcast_id` (`broadcast_id`),
  INDEX `idx_sms_recipients_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. SMS Attempts Tracker
CREATE TABLE IF NOT EXISTS `sms_send_attempts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `attempt_id` VARCHAR(50) UNIQUE NOT NULL,
  `branch_id` BIGINT UNSIGNED NOT NULL,
  `broadcast_id` VARCHAR(50) NOT NULL,
  `recipient_id` VARCHAR(50) NOT NULL,
  `config_id` VARCHAR(50) NOT NULL,
  `attempt_number` INT NOT NULL,
  `error_message` TEXT NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. SMS Daily Usage Limit Tracker
CREATE TABLE IF NOT EXISTS `sms_daily_usage` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `branch_id` VARCHAR(50) NOT NULL,
  `config_id` VARCHAR(50) NOT NULL,
  `usage_date` DATE NOT NULL,
  `sms_sent` INT DEFAULT 0 NULL,
  `reset_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NULL,
  UNIQUE KEY `unique_sms_branch_config_date` (`branch_id`, `config_id`, `usage_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
