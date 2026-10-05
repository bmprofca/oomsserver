ALTER TABLE `in_app_voice_calls`
  ADD COLUMN `initiated_by` ENUM('staff', 'client') NOT NULL DEFAULT 'staff' AFTER `client_name`,
  ADD COLUMN `recipient_panel` ENUM('client', 'ca', 'enduser') NOT NULL DEFAULT 'client' AFTER `initiated_by`,
  ADD KEY `idx_in_app_voice_client_incoming` (`client_username`, `initiated_by`, `recipient_panel`, `status`, `expires_at`),
  ADD KEY `idx_in_app_voice_staff_incoming` (`caller_username`, `initiated_by`, `recipient_panel`, `status`, `expires_at`);
