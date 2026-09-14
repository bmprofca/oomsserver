-- Client follow-up: assign clients to staff for collection / follow-up work.

CREATE TABLE IF NOT EXISTS `client_followup_assignments` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `assignment_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `client_username` VARCHAR(100) NOT NULL,
  `staff_username` VARCHAR(100) NOT NULL,
  `remark` VARCHAR(255) NULL DEFAULT NULL,
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cfa_assignment_id` (`assignment_id`),
  UNIQUE KEY `uk_cfa_branch_client` (`branch_id`, `client_username`),
  KEY `idx_cfa_branch_staff` (`branch_id`, `staff_username`),
  KEY `idx_cfa_staff` (`staff_username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `client_followup_notes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `note_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `client_username` VARCHAR(100) NOT NULL,
  `subject` VARCHAR(255) NULL DEFAULT NULL,
  `note` TEXT NULL,
  `priority` VARCHAR(20) NOT NULL DEFAULT 'medium',
  `status` VARCHAR(20) NOT NULL DEFAULT 'open',
  `reminder_at` DATETIME NULL DEFAULT NULL,
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_deleted` ENUM('0','1') NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cfn_note_id` (`note_id`),
  KEY `idx_cfn_branch_client` (`branch_id`, `client_username`, `is_deleted`),
  KEY `idx_cfn_reminder` (`branch_id`, `reminder_at`, `status`, `is_deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
