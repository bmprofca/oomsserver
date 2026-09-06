-- Company / platform SMTP for system emails (login OTP email, CA approval, invitations).
-- Multiple rows allowed. Only one row with status active is used by SendMail.
-- Activating a config deactivates the others.
CREATE TABLE IF NOT EXISTS `email_company_smtp_config` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `config_name` VARCHAR(120) NOT NULL,
  `host` VARCHAR(255) NOT NULL,
  `port` INT NOT NULL DEFAULT 587,
  `secure` TINYINT(1) NOT NULL DEFAULT 0,
  `username` VARCHAR(255) NOT NULL,
  `password_encrypted` TEXT NOT NULL,
  `from_email` VARCHAR(255) NOT NULL,
  `from_name` VARCHAR(120) NULL DEFAULT NULL,
  `reply_to` VARCHAR(255) NULL DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'inactive',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_email_company_smtp_config_id` (`config_id`),
  KEY `idx_email_company_smtp_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
