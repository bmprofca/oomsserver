-- Monthly staff bonus / fine entries applied on payslip generation.
-- Multiple rows per staff+month allowed.

CREATE TABLE IF NOT EXISTS staff_bonus_fine (
  id INT(11) NOT NULL AUTO_INCREMENT,
  branch_id VARCHAR(100) NOT NULL,
  entry_id VARCHAR(100) NOT NULL,
  create_by VARCHAR(100) NOT NULL,
  modify_by VARCHAR(100) NOT NULL,
  create_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  username VARCHAR(100) NOT NULL COMMENT 'Staff username',
  type ENUM('bonus','fine') NOT NULL,
  year SMALLINT NOT NULL,
  month TINYINT NOT NULL COMMENT '1-12',
  amount DECIMAL(25,2) NOT NULL DEFAULT 0.00,
  remark VARCHAR(500) NOT NULL,
  is_deleted ENUM('0','1') NOT NULL DEFAULT '0',
  deleted_by VARCHAR(100) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bonus_fine_entry (entry_id),
  KEY idx_bonus_fine_staff_month (branch_id, username, year, month),
  KEY idx_bonus_fine_branch_type (branch_id, type, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
