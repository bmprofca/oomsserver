CREATE TABLE IF NOT EXISTS `appointments` (
  `appointment_id` VARCHAR(48) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `client_username` VARCHAR(100) NOT NULL,
  `client_name` VARCHAR(255) NOT NULL,
  `created_by` VARCHAR(100) NOT NULL,
  `notes` TEXT NULL,
  `start_at` DATETIME NOT NULL,
  `end_at` DATETIME NOT NULL,
  `timezone` VARCHAR(64) NOT NULL,
  `status` ENUM('scheduled','cancelled') NOT NULL DEFAULT 'scheduled',
  `google_event_id` VARCHAR(64) NOT NULL,
  `calendar_sync_status` ENUM('pending','synced','failed','cancelled') NOT NULL DEFAULT 'pending',
  `calendar_sync_error` TEXT NULL,
  `calendar_sync_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `calendar_retry_at` DATETIME NULL,
  `calendar_synced_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `cancelled_at` DATETIME NULL,
  PRIMARY KEY (`appointment_id`),
  UNIQUE KEY `uq_appointments_google_event` (`google_event_id`),
  KEY `idx_appointments_branch_start` (`branch_id`, `status`, `start_at`),
  KEY `idx_appointments_client` (`branch_id`, `client_username`, `start_at`),
  KEY `idx_appointments_calendar_retry` (`calendar_sync_status`, `calendar_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `appointment_attendees` (
  `appointment_id` VARCHAR(48) NOT NULL,
  `attendee_username` VARCHAR(100) NOT NULL,
  `attendee_name` VARCHAR(255) NOT NULL,
  `attendee_email` VARCHAR(320) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`appointment_id`, `attendee_username`),
  KEY `idx_appointment_attendees_user` (`attendee_username`, `appointment_id`),
  CONSTRAINT `fk_appointment_attendees_appointment`
    FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`appointment_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
