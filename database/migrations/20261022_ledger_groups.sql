-- S02: tenant-scoped ledger groups and shared audit events.
-- Rollback: stop ledger-group writes, archive/export `ledger_groups` and
-- `audit_events`, then drop them only after finance history and audit retention
-- requirements have been confirmed.

CREATE TABLE IF NOT EXISTS `audit_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_id` VARCHAR(40) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `actor_username` VARCHAR(100) NOT NULL,
  `event_type` VARCHAR(100) NOT NULL,
  `entity_type` VARCHAR(100) NOT NULL,
  `entity_id` VARCHAR(100) NOT NULL,
  `metadata` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_audit_event_id` (`event_id`),
  KEY `idx_audit_branch_entity` (`branch_id`, `entity_type`, `entity_id`, `created_at`),
  KEY `idx_audit_branch_actor` (`branch_id`, `actor_username`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ledger_groups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ledger_group_id` VARCHAR(40) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `parent_group_id` VARCHAR(40) NULL,
  `name` VARCHAR(150) NOT NULL,
  `group_type` ENUM('asset', 'liability', 'equity', 'income', 'expense') NOT NULL,
  `normal_balance` ENUM('debit', 'credit') NOT NULL,
  `status` CHAR(1) NOT NULL DEFAULT '1',
  `is_system` CHAR(1) NOT NULL DEFAULT '0',
  `is_deleted` CHAR(1) NOT NULL DEFAULT '0',
  `create_by` VARCHAR(100) NOT NULL,
  `modify_by` VARCHAR(100) NOT NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ledger_group_id` (`ledger_group_id`),
  UNIQUE KEY `uq_ledger_group_branch_name` (`branch_id`, `name`),
  KEY `idx_ledger_group_branch` (`branch_id`, `is_deleted`, `status`),
  KEY `idx_ledger_group_parent` (`branch_id`, `parent_group_id`, `is_deleted`),
  CONSTRAINT `fk_ledger_group_parent` FOREIGN KEY (`parent_group_id`)
    REFERENCES `ledger_groups` (`ledger_group_id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
