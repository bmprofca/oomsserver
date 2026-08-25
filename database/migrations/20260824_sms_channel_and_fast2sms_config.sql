-- SMS channel on each branch (disabled | fast2sms). More providers can be added later.
ALTER TABLE `branch_list`
  ADD COLUMN `sms_channel` VARCHAR(30) NOT NULL DEFAULT 'disabled';

-- Fast2SMS credentials for a branch (one active config per branch, like OneChatting project token).
CREATE TABLE IF NOT EXISTS `sms_fast2sms_configs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
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
  UNIQUE KEY `uk_sms_fast2sms_config_id` (`config_id`),
  UNIQUE KEY `uk_sms_fast2sms_branch` (`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
