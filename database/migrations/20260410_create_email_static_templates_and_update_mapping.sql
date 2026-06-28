CREATE TABLE IF NOT EXISTS email_static_templates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  template_id VARCHAR(50) NOT NULL UNIQUE,
  branch_id BIGINT NOT NULL,
  template_type VARCHAR(100) NOT NULL COMMENT 'Examples: task_create, payment_receipt, tax_complete, tag_create',
  template_name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  html_body LONGTEXT NOT NULL,
  text_body TEXT NULL,
  variables_json JSON NULL COMMENT 'Example: [\"task_name\",\"customer_name\"]',
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  create_by VARCHAR(100) NULL,
  modify_by VARCHAR(100) NULL,
  create_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_branch_type_status (branch_id, template_type, status),
  INDEX idx_branch_default (branch_id, template_type, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE email_static_mapping
  ADD COLUMN IF NOT EXISTS payment_receipt VARCHAR(100) NULL AFTER task_create,
  ADD COLUMN IF NOT EXISTS tax_complete VARCHAR(100) NULL AFTER payment_receipt,
  ADD COLUMN IF NOT EXISTS tag_create VARCHAR(100) NULL AFTER tax_complete;

CREATE INDEX idx_email_static_templates_branch_type_status
  ON email_static_templates (branch_id, template_type, status);
