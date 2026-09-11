-- Global OOMS System WhatsApp template definitions (content previously in WP_SYSTEM_TEMPLATES.json).
-- Branch mapping remains in wp_system_template_mapping (type → template_name).
CREATE TABLE IF NOT EXISTS `wp_system_templates` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `template_id` VARCHAR(50) NOT NULL,
  `type` VARCHAR(80) NOT NULL,
  `template_name` VARCHAR(120) NOT NULL,
  `category` VARCHAR(40) NOT NULL DEFAULT 'UTILITY',
  `language` VARCHAR(20) NOT NULL DEFAULT 'en',
  `template_json` LONGTEXT NOT NULL,
  `example_json` LONGTEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wp_system_templates_id` (`template_id`),
  UNIQUE KEY `uk_wp_system_templates_type_name` (`type`, `template_name`),
  KEY `idx_wp_system_templates_type` (`type`),
  KEY `idx_wp_system_templates_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
