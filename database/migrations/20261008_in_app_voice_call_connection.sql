ALTER TABLE `in_app_voice_calls`
  ADD COLUMN `connected_at` DATETIME NULL AFTER `accepted_at`;
