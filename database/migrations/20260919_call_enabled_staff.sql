-- Per-staff click-to-call enable flag (mirrors onechatting_enabled).
-- When enabled, call_extension is required.

ALTER TABLE `branch_mapping`
  ADD COLUMN `call_enabled` ENUM('0','1') NOT NULL DEFAULT '0'
    COMMENT '1 = click-to-call enabled for this staff'
    AFTER `call_extension`;

-- Backfill: anyone who already has an extension is treated as enabled
UPDATE `branch_mapping`
SET `call_enabled` = '1'
WHERE `call_extension` IS NOT NULL
  AND TRIM(`call_extension`) <> '';
