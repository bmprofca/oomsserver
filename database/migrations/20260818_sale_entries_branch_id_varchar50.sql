-- sale_entries.branch_id stores branch codes like YMKELM, not numeric IDs.
-- Use VARCHAR(50) so existing branch_id indexes remain valid.

ALTER TABLE `sale_entries`
  MODIFY COLUMN `branch_id` VARCHAR(50) NULL DEFAULT NULL;

-- Backfill corrupted numeric zero rows from the linked invoice row.
UPDATE `sale_entries` se
INNER JOIN `invoice` i
  ON i.invoice_id = se.invoice_id
SET se.branch_id = i.branch_id
WHERE CAST(se.branch_id AS CHAR) = '0'
  AND i.branch_id IS NOT NULL
  AND TRIM(CAST(i.branch_id AS CHAR)) <> '';
