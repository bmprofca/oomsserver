-- Help & Support FAQs + expand contact intro_text

ALTER TABLE `help_support_platform_config`
  MODIFY COLUMN `intro_text` TEXT NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `help_support_faqs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `faq_id` VARCHAR(50) NOT NULL,
  `question` VARCHAR(500) NOT NULL,
  `answer` TEXT NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_help_support_faq_id` (`faq_id`),
  KEY `idx_help_support_faqs_status_sort` (`status`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
