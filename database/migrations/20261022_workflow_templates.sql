-- E1: versioned service workflow templates and task snapshots.
-- Rollback: stop template assignment, archive the tables, then drop only after
-- task_workflow_snapshots has been exported for audit/history retention.

CREATE TABLE IF NOT EXISTS `workflow_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workflow_template_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `service_id` VARCHAR(50) NULL DEFAULT NULL,
  `version` INT UNSIGNED NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `status` ENUM('active','archived') NOT NULL DEFAULT 'active',
  `definition_json` JSON NOT NULL,
  `create_by` VARCHAR(100) NOT NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_workflow_template_version` (`branch_id`, `workflow_template_id`, `version`),
  KEY `idx_workflow_template_active_service` (`branch_id`, `service_id`, `status`, `version`),
  KEY `idx_workflow_template_name` (`branch_id`, `name`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `task_workflow_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `branch_id` VARCHAR(50) NOT NULL,
  `task_id` VARCHAR(50) NOT NULL,
  `workflow_template_id` VARCHAR(50) NOT NULL,
  `template_version` INT UNSIGNED NOT NULL,
  `snapshot_json` JSON NOT NULL,
  `create_by` VARCHAR(100) NOT NULL,
  `create_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_task_workflow_snapshot` (`branch_id`, `task_id`),
  KEY `idx_task_workflow_template` (`branch_id`, `workflow_template_id`, `template_version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
