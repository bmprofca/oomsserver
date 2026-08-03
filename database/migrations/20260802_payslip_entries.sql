-- Monthly staff payslips posted to ledger (mirrors discount_entries pattern).
-- Key: branch_id + username + year + month (not salary_id).

CREATE TABLE IF NOT EXISTS payslip_entries (
  id INT(11) NOT NULL AUTO_INCREMENT,
  branch_id VARCHAR(100) NOT NULL,
  payslip_id VARCHAR(100) NOT NULL,
  create_by VARCHAR(100) NOT NULL,
  modify_by VARCHAR(100) NOT NULL,
  create_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  username VARCHAR(100) NOT NULL COMMENT 'Staff username',
  year SMALLINT NOT NULL,
  month TINYINT NOT NULL COMMENT '1-12',
  amount DECIMAL(25,2) NOT NULL DEFAULT 0.00,
  payslip_date DATE NOT NULL COMMENT 'transaction / expense date used',
  invoice_id VARCHAR(100) DEFAULT NULL,
  invoice_no VARCHAR(100) DEFAULT NULL,
  transaction_id VARCHAR(100) DEFAULT NULL,
  expense_id VARCHAR(100) DEFAULT NULL,
  remark VARCHAR(500) DEFAULT NULL,
  is_deleted ENUM('0','1') NOT NULL DEFAULT '0',
  deleted_by VARCHAR(100) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payslip_id (payslip_id),
  UNIQUE KEY uk_payslip_staff_month (branch_id, username, year, month),
  KEY idx_payslip_branch_user (branch_id, username),
  KEY idx_payslip_year_month (branch_id, year, month),
  KEY idx_payslip_transaction (transaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
