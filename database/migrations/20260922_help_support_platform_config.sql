-- Platform Help & Support contact details (managed from Admin).

CREATE TABLE IF NOT EXISTS `help_support_platform_config` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `page_title` VARCHAR(150) NOT NULL DEFAULT 'Help & Support',
  `intro_text` VARCHAR(500) NULL DEFAULT NULL,
  `support_email` VARCHAR(150) NULL DEFAULT NULL,
  `support_phone` VARCHAR(40) NULL DEFAULT NULL,
  `support_whatsapp` VARCHAR(40) NULL DEFAULT NULL,
  `support_hours` VARCHAR(200) NULL DEFAULT NULL,
  `support_address` VARCHAR(500) NULL DEFAULT NULL,
  `website_url` VARCHAR(300) NULL DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_help_support_config_id` (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
