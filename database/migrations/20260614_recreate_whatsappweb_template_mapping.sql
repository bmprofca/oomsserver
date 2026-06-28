DROP TABLE IF EXISTS `whatsappweb_template_mapping`;

CREATE TABLE IF NOT EXISTS `whatsappweb_template_mapping` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `template_id` VARCHAR(50) UNIQUE NOT NULL,
  `branch_id` TEXT NOT NULL,
  `template_name` VARCHAR(150) NOT NULL COMMENT 'System template name from WhatsAppTemplates TEMPLATELIST',
  `template_type` ENUM('text','image','video','document','audio') NOT NULL DEFAULT 'text',
  `content_json` LONGTEXT NOT NULL,
  `variables_json` TEXT NULL,
  `status` ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(100) NULL,
  `modify_by` VARCHAR(100) NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_whatsappweb_template_mapping_branch_status` (`branch_id`(100), `status`),
  INDEX `idx_whatsappweb_template_mapping_branch_name` (`branch_id`(100), `template_name`(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
