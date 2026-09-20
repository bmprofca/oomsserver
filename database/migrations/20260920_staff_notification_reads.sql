-- Per-staff notification read state for header notifications
-- (CA approval alerts + Incoming/SHARABLE document uploads).

CREATE TABLE IF NOT EXISTS `staff_notification_reads` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `branch_id` VARCHAR(50) NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `notification_id` VARCHAR(100) NOT NULL,
  `read_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_staff_notif_read` (`branch_id`, `username`, `notification_id`),
  KEY `idx_staff_notif_branch_user` (`branch_id`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- If the table already exists with a different collation, normalize it.
ALTER TABLE `staff_notification_reads`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
