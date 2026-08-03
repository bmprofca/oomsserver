-- Salary definitions (fixed | flexible) and staff assignments with effective_from.
-- Only one assignment per staff/branch may be is_active = '1' at a time.

CREATE TABLE IF NOT EXISTS salaries (
  id INT(11) NOT NULL AUTO_INCREMENT,
  salary_id VARCHAR(50) NOT NULL,
  branch_id VARCHAR(50) NOT NULL,
  salary_type ENUM('fixed','flexible') NOT NULL DEFAULT 'fixed',
  amount DECIMAL(12,2) NOT NULL,
  monthly_working_hours DECIMAL(8,2) DEFAULT NULL COMMENT 'Required for flexible: hours to fulfill for full monthly salary',
  create_by VARCHAR(50) NOT NULL,
  modify_by VARCHAR(50) NOT NULL,
  create_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted ENUM('0','1') DEFAULT '0',
  deleted_by VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_salaries_salary_id (salary_id),
  KEY idx_salaries_branch (branch_id),
  KEY idx_salaries_type (salary_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_salary_assignments (
  id INT(11) NOT NULL AUTO_INCREMENT,
  assignment_id VARCHAR(50) NOT NULL,
  salary_id VARCHAR(50) NOT NULL,
  map_id VARCHAR(50) NOT NULL,
  username VARCHAR(50) NOT NULL,
  branch_id VARCHAR(50) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE DEFAULT NULL,
  is_active ENUM('0','1') DEFAULT '0',
  working_hours_start TIME DEFAULT '10:00:00',
  working_hours_end TIME DEFAULT '18:00:00',
  expected_hours DECIMAL(5,2) DEFAULT 8.00,
  grace_period_minutes INT(11) DEFAULT 10,
  overtime_rate_type ENUM('monthly','daily') DEFAULT 'daily',
  fine_rate_type ENUM('monthly','daily') DEFAULT 'daily',
  overtime_enabled TINYINT(4) DEFAULT 1,
  fine_enabled TINYINT(4) DEFAULT 1,
  allowed_break_minutes INT(11) DEFAULT 30,
  break_excess_penalty_type ENUM('fixed','percentage') DEFAULT 'fixed',
  break_excess_penalty_value DECIMAL(10,2) DEFAULT 0.00,
  travel_allowance_type ENUM('fixed','percentage') DEFAULT 'fixed',
  travel_allowance_value DECIMAL(10,2) DEFAULT 0.00,
  other_deduction_type ENUM('fixed','percentage') DEFAULT 'percentage',
  other_deduction_value DECIMAL(10,2) DEFAULT 0.00,
  create_by VARCHAR(50) NOT NULL,
  modify_by VARCHAR(50) NOT NULL,
  create_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted ENUM('0','1') DEFAULT '0',
  deleted_by VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_assignment_id (assignment_id),
  KEY idx_ssa_salary_id (salary_id),
  KEY idx_ssa_map_id (map_id),
  KEY idx_ssa_username_branch (username, branch_id),
  KEY idx_ssa_effective (username, branch_id, effective_from),
  KEY idx_ssa_active (username, branch_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill from legacy staff_salary (idempotent via NOT EXISTS)
INSERT INTO salaries (
  salary_id,
  branch_id,
  salary_type,
  amount,
  monthly_working_hours,
  create_by,
  modify_by,
  create_date,
  modify_date,
  is_deleted,
  deleted_by
)
SELECT
  ss.salary_id,
  ss.branch_id,
  'fixed',
  ss.monthly_salary,
  NULL,
  ss.create_by,
  ss.modify_by,
  ss.create_date,
  ss.modify_date,
  ss.is_deleted,
  ss.deleted_by
FROM staff_salary ss
WHERE NOT EXISTS (
  SELECT 1 FROM salaries s WHERE s.salary_id = ss.salary_id
);

INSERT INTO staff_salary_assignments (
  assignment_id,
  salary_id,
  map_id,
  username,
  branch_id,
  effective_from,
  effective_to,
  is_active,
  working_hours_start,
  working_hours_end,
  expected_hours,
  grace_period_minutes,
  overtime_rate_type,
  fine_rate_type,
  overtime_enabled,
  fine_enabled,
  allowed_break_minutes,
  break_excess_penalty_type,
  break_excess_penalty_value,
  travel_allowance_type,
  travel_allowance_value,
  other_deduction_type,
  other_deduction_value,
  create_by,
  modify_by,
  create_date,
  modify_date,
  is_deleted,
  deleted_by
)
SELECT
  CONCAT('ASN_', ss.salary_id),
  ss.salary_id,
  ss.map_id,
  ss.username,
  ss.branch_id,
  ss.effective_from,
  ss.effective_to,
  ss.is_active,
  ss.working_hours_start,
  ss.working_hours_end,
  ss.expected_hours,
  ss.grace_period_minutes,
  ss.overtime_rate_type,
  ss.fine_rate_type,
  ss.overtime_enabled,
  ss.fine_enabled,
  ss.allowed_break_minutes,
  ss.break_excess_penalty_type,
  ss.break_excess_penalty_value,
  ss.travel_allowance_type,
  ss.travel_allowance_value,
  ss.other_deduction_type,
  ss.other_deduction_value,
  ss.create_by,
  ss.modify_by,
  ss.create_date,
  ss.modify_date,
  ss.is_deleted,
  ss.deleted_by
FROM staff_salary ss
WHERE NOT EXISTS (
  SELECT 1 FROM staff_salary_assignments a WHERE a.salary_id = ss.salary_id
);
