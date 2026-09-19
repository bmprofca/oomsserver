-- OOMS System Call (PBX) channel — admin API URL + branch channel/token + staff extensions.

CREATE TABLE IF NOT EXISTS `call_system_pbx_config` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `api_base_url` VARCHAR(500) NOT NULL COMMENT 'Full PBX initiate URL, e.g. https://ipbx.example.com/api/pbx/calls',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_call_system_pbx_config_id` (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `call_branch_configs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `api_key_encrypted` TEXT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_call_branch_config_id` (`config_id`),
  UNIQUE KEY `uk_call_branch_branch_id` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `call_pbx_logs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `log_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `initiated_by` VARCHAR(50) NOT NULL,
  `extension` VARCHAR(50) NOT NULL,
  `phone_number` VARCHAR(30) NOT NULL,
  `pbx_call_id` VARCHAR(100) NULL DEFAULT NULL,
  `request_id` VARCHAR(100) NULL DEFAULT NULL,
  `call_status` VARCHAR(50) NULL DEFAULT NULL,
  `raw_response` MEDIUMTEXT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_call_pbx_log_id` (`log_id`),
  KEY `idx_call_pbx_branch_date` (`branch_id`, `create_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `branch_list`
  ADD COLUMN `call_channel` VARCHAR(30) NOT NULL DEFAULT 'disabled'
    COMMENT 'disabled | ooms system'
    AFTER `sms_channel`;

ALTER TABLE `branch_mapping`
  ADD COLUMN `call_extension` VARCHAR(50) NULL DEFAULT NULL
    COMMENT 'PBX extension for click-to-call'
    AFTER `onechatting_token`;
