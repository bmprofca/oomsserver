CREATE TABLE IF NOT EXISTS email_static_mapping (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  mapping_id VARCHAR(50) NOT NULL UNIQUE,
  branch_id BIGINT NOT NULL,
  activity_key VARCHAR(100) NOT NULL COMMENT 'Examples: tag_create, payment_receipt, tax_complete, task_created',
  template_id VARCHAR(50) NOT NULL COMMENT 'References email_templates.template_id',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  priority INT NOT NULL DEFAULT 1 COMMENT 'Lower number = higher priority',
  notes VARCHAR(255) NULL,
  create_by VARCHAR(100) NULL,
  modify_by VARCHAR(100) NULL,
  create_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_branch_activity_template (branch_id, activity_key, template_id),
  INDEX idx_branch_activity (branch_id, activity_key),
  INDEX idx_branch_activity_active (branch_id, activity_key, is_active, status),
  INDEX idx_template_id (template_id),
  CONSTRAINT fk_email_static_mapping_template
    FOREIGN KEY (template_id) REFERENCES email_templates(template_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
