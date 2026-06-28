-- sale_entries: task-billing flag (0 = manual sale, default; 1 = from task billing).
-- On databases that still have legacy column `type` (varchar), run before this file:
--   UPDATE `sale_entries` SET `is_task` = '1' WHERE `type` = 'task';
--   ALTER TABLE `sale_entries` DROP COLUMN `type`;
ALTER TABLE `sale_entries` ADD COLUMN `is_task` ENUM('0','1') NOT NULL DEFAULT '0' AFTER `total`;
