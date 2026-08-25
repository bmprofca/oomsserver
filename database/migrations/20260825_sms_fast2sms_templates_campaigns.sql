-- Fast2SMS DLT/Quick templates (branch-owned message definitions).
CREATE TABLE IF NOT EXISTS `sms_fast2sms_templates` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `template_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `dlt_message_id` VARCHAR(50) NULL DEFAULT NULL COMMENT 'Fast2SMS / DLT Message ID',
  `message_body` TEXT NULL COMMENT 'Approved text with {#var#} for DLT vars',
  `variable_keys` TEXT NULL COMMENT 'JSON array of variable keys in DLT order',
  `sender_id` VARCHAR(20) NULL DEFAULT NULL,
  `route` VARCHAR(20) NOT NULL DEFAULT 'dlt',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_f2s_template_id` (`template_id`),
  KEY `idx_sms_f2s_tpl_branch_status` (`branch_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Map OOMS system notification types (TEMPLATELIST) → Fast2SMS templates.
CREATE TABLE IF NOT EXISTS `sms_fast2sms_template_mapping` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `map_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `template_type` VARCHAR(150) NOT NULL COMMENT 'System type from TEMPLATELIST',
  `sms_template_id` VARCHAR(50) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_f2s_map_id` (`map_id`),
  UNIQUE KEY `uk_sms_f2s_map_branch_type` (`branch_id`, `template_type`),
  KEY `idx_sms_f2s_map_branch_status` (`branch_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Local SMS campaigns (list doubles as report hub).
CREATE TABLE IF NOT EXISTS `sms_fast2sms_campaigns` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `campaign_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `template_id` VARCHAR(50) NULL DEFAULT NULL,
  `template_name` VARCHAR(150) NULL DEFAULT NULL,
  `dlt_message_id` VARCHAR(50) NULL DEFAULT NULL,
  `message_body` TEXT NULL,
  `route` VARCHAR(20) NOT NULL DEFAULT 'dlt',
  `sender_id` VARCHAR(20) NULL DEFAULT NULL,
  `variables_values` TEXT NULL COMMENT 'Pipe-separated DLT variable values',
  `audience_json` TEXT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `schedule_at` DATETIME NULL DEFAULT NULL,
  `total_count` INT NOT NULL DEFAULT 0,
  `sent_count` INT NOT NULL DEFAULT 0,
  `failed_count` INT NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_f2s_campaign_id` (`campaign_id`),
  KEY `idx_sms_f2s_camp_branch_status` (`branch_id`, `status`),
  KEY `idx_sms_f2s_camp_branch_date` (`branch_id`, `create_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-recipient campaign delivery rows.
CREATE TABLE IF NOT EXISTS `sms_fast2sms_campaign_messages` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `message_id` VARCHAR(50) NOT NULL,
  `campaign_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `mobile` VARCHAR(20) NOT NULL,
  `name` VARCHAR(150) NULL DEFAULT NULL,
  `username` VARCHAR(100) NULL DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `provider_request_id` VARCHAR(100) NULL DEFAULT NULL,
  `error_message` TEXT NULL,
  `sent_at` DATETIME NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_f2s_msg_id` (`message_id`),
  KEY `idx_sms_f2s_msg_campaign_status` (`campaign_id`, `status`),
  KEY `idx_sms_f2s_msg_branch` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
