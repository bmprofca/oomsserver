CREATE TABLE IF NOT EXISTS `whatsappweb_templates` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `template_id` VARCHAR(50) UNIQUE NOT NULL,
  `branch_id` TEXT NOT NULL,
  `template_name` VARCHAR(150) NOT NULL,
  `template_type` ENUM('text','image','video','document','audio') NOT NULL DEFAULT 'text',
  `content_json` LONGTEXT NOT NULL,
  `variables_json` TEXT NULL,
  `status` ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(100) NULL,
  `modify_by` VARCHAR(100) NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_whatsappweb_templates_branch_status` (`branch_id`(100), `status`),
  INDEX `idx_whatsappweb_templates_branch_type` (`branch_id`(100), `template_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
