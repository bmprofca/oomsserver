-- Platform Razorpay payment gateway credentials (admin-managed).

CREATE TABLE IF NOT EXISTS `razorpay_platform_config` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `config_id` VARCHAR(50) NOT NULL,
  `environment` VARCHAR(10) NOT NULL DEFAULT 'test' COMMENT 'test | live',
  `key_id` VARCHAR(100) NOT NULL DEFAULT '',
  `key_secret` VARCHAR(255) NOT NULL DEFAULT '',
  `webhook_secret` VARCHAR(255) NOT NULL DEFAULT '',
  `webhook_url` VARCHAR(500) NULL DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_razorpay_platform_config_id` (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
