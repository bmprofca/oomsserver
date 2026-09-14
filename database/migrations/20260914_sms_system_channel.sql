-- OOMS System SMS channel (platform Fast2SMS, separate from OTP company config).

CREATE TABLE IF NOT EXISTS `sms_system_fast2sms_config` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `auth_token_encrypted` TEXT NOT NULL,
  `sender_id` VARCHAR(20) NULL DEFAULT NULL,
  `entity_id` VARCHAR(50) NULL DEFAULT NULL,
  `route` VARCHAR(20) NOT NULL DEFAULT 'dlt',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_system_f2s_config_id` (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sms_system_templates` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `template_id` VARCHAR(50) NOT NULL,
  `type` VARCHAR(80) NOT NULL COMMENT 'SMS_TEMPLATELIST name or campaign',
  `name` VARCHAR(150) NOT NULL,
  `dlt_message_id` VARCHAR(50) NULL DEFAULT NULL COMMENT 'Fast2SMS / DLT Message ID',
  `message_body` TEXT NULL COMMENT 'Approved text with {#var#} for DLT vars',
  `variable_keys` TEXT NULL COMMENT 'JSON array of OOMS keys in DLT order',
  `sender_id` VARCHAR(20) NULL DEFAULT NULL,
  `route` VARCHAR(20) NOT NULL DEFAULT 'dlt',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_system_template_id` (`template_id`),
  UNIQUE KEY `uk_sms_system_type_name` (`type`, `name`),
  KEY `idx_sms_system_tpl_type` (`type`),
  KEY `idx_sms_system_tpl_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sms_system_template_mapping` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `map_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `template_type` VARCHAR(150) NOT NULL COMMENT 'System type from SMS_TEMPLATELIST',
  `sms_template_id` VARCHAR(50) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_system_map_id` (`map_id`),
  UNIQUE KEY `uk_sms_system_map_branch_type` (`branch_id`, `template_type`),
  KEY `idx_sms_system_map_branch_status` (`branch_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Allow campaigns / schedules to use OOMS System credentials + templates.
ALTER TABLE `sms_fast2sms_campaigns`
  ADD COLUMN `channel_source` VARCHAR(30) NOT NULL DEFAULT 'fast2sms'
    COMMENT 'fast2sms | ooms_system'
    AFTER `branch_id`;

ALTER TABLE `sms_fast2sms_campaign_schedules`
  ADD COLUMN `channel_source` VARCHAR(30) NOT NULL DEFAULT 'fast2sms'
    COMMENT 'fast2sms | ooms_system'
    AFTER `branch_id`;
