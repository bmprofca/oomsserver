-- Link CA (or other) purchases to a task when generated from task CA purchase.
ALTER TABLE `purchase_entries`
  ADD COLUMN `task_id` VARCHAR(100) NULL DEFAULT NULL AFTER `party_type`;

CREATE INDEX `idx_purchase_entries_task`
  ON `purchase_entries` (`branch_id`, `task_id`);

-- Backfill from purchase_items.remark (historically stored the task_id for CA purchases).
UPDATE `purchase_entries` pe
INNER JOIN (
  SELECT
    pi.purchase_id,
    pi.branch_id,
    pi.remark AS task_id
  FROM `purchase_items` pi
  INNER JOIN `tasks` t
    ON t.task_id = pi.remark
   AND CAST(t.branch_id AS CHAR) = CAST(pi.branch_id AS CHAR)
  WHERE pi.remark IS NOT NULL
    AND TRIM(pi.remark) <> ''
  GROUP BY pi.purchase_id, pi.branch_id, pi.remark
) src
  ON src.purchase_id = pe.purchase_id
 AND CAST(src.branch_id AS CHAR) = CAST(pe.branch_id AS CHAR)
SET pe.task_id = src.task_id
WHERE pe.task_id IS NULL;
