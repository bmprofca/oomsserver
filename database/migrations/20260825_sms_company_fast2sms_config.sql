-- Company / platform Fast2SMS for login register portal OTP (not branch notifications).
-- Prefer an active DB row here. If missing, OTP helpers fall back to SERVER .env.
CREATE TABLE IF NOT EXISTS `sms_company_fast2sms_config` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `auth_token_encrypted` TEXT NOT NULL,
  `sender_id` VARCHAR(20) NULL DEFAULT NULL,
  `entity_id` VARCHAR(50) NULL DEFAULT NULL,
  `route` VARCHAR(20) NOT NULL DEFAULT 'dlt',
  `otp_dlt_message_id` VARCHAR(50) NULL DEFAULT NULL COMMENT 'DLT Message ID used for OTP SMS',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sms_company_f2s_config_id` (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
