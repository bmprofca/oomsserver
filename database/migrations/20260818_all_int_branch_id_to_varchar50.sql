-- Convert remaining integer branch_id columns to string branch codes.
-- Practical implementation uses VARCHAR(50) NULL DEFAULT NULL so indexes remain usable.

ALTER TABLE `email_broadcasts`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `email_broadcast_recipients`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `email_configs`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `email_static`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `email_static_templates`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `email_templates`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `purchase_entries`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `sms_broadcasts`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `sms_broadcast_recipients`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `sms_configs`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `sms_send_attempts`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

ALTER TABLE `sms_templates`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;
