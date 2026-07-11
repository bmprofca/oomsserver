-- Backfill razorpay_orders.branch_id (collation-safe join)

UPDATE razorpay_orders ro
INNER JOIN (
  SELECT username, MIN(branch_id) AS branch_id
  FROM branch_mapping
  WHERE type = 'admin'
    AND is_deleted = '0'
  GROUP BY username
) bm ON bm.username COLLATE utf8mb4_unicode_ci = ro.username COLLATE utf8mb4_unicode_ci
SET ro.branch_id = bm.branch_id
WHERE ro.branch_id IS NULL;
