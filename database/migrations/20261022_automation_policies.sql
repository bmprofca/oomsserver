-- S06: branch/client automation settings persistence.
-- Rollback: disable policy writes, archive/export this table, then drop
-- `automation_policies` only after dependent audit history is retained.

CREATE TABLE IF NOT EXISTS `automation_policies` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `branch_id` VARCHAR(50) NOT NULL,
  `scope_type` ENUM('branch', 'client') NOT NULL,
  `scope_id` VARCHAR(100) NOT NULL,
  `policy_key` VARCHAR(60) NOT NULL,
  `enabled` CHAR(1) NOT NULL DEFAULT '0',
  `config` JSON NULL,
  `create_by` VARCHAR(100) NOT NULL,
  `modify_by` VARCHAR(100) NOT NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_automation_policy_scope` (`branch_id`, `scope_type`, `scope_id`, `policy_key`),
  KEY `idx_automation_policy_branch` (`branch_id`, `scope_type`, `scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
