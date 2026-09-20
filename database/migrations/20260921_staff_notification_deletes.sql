-- Per-staff deleted header notifications (hidden from menu until source changes).

CREATE TABLE IF NOT EXISTS `staff_notification_deletes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `branch_id` VARCHAR(50) NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `notification_id` VARCHAR(100) NOT NULL,
  `deleted_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_staff_notif_delete` (`branch_id`, `username`, `notification_id`),
  KEY `idx_staff_notif_del_branch_user` (`branch_id`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `staff_notification_deletes`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
