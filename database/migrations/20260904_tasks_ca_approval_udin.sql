-- CA approval workflow + UDIN on tasks
-- ca_approval: pending (default) → sent (awaiting CA) → complete
-- Only meaningful when has_ca = '1'
ALTER TABLE `tasks`
  ADD COLUMN `ca_approval` ENUM('pending','sent','complete') NOT NULL DEFAULT 'pending' AFTER `ca_id`,
  ADD COLUMN `udin` VARCHAR(100) NULL DEFAULT NULL AFTER `ca_approval`;
