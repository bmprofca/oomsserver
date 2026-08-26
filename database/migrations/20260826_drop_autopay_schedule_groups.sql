-- Drop obsolete schedule-group tables (replaced by per-client autopay_clients).
-- Keep: autopay_clients, autopay_logs

-- Migrate any remaining active group members before drop
INSERT INTO `autopay_clients` (
  `reminder_id`, `branch_id`, `username`, `schedule_type`, `schedule_config`,
  `channels`, `is_active`, `create_by`, `create_date`
)
SELECT
  CONCAT('apr_', LOWER(HEX(RANDOM_BYTES(8)))),
  src.branch_id,
  src.username,
  src.schedule_type,
  src.schedule_config,
  JSON_ARRAY('email'),
  src.is_active,
  src.added_by,
  src.added_date
FROM (
  SELECT
    gm.branch_id,
    gm.username,
    g.schedule_type,
    g.schedule_config,
    IF(g.is_active = 1 AND gm.status = 'active', 1, 0) AS is_active,
    gm.added_by,
    COALESCE(gm.added_date, NOW()) AS added_date,
    ROW_NUMBER() OVER (
      PARTITION BY gm.branch_id, gm.username
      ORDER BY gm.added_date ASC, gm.id ASC
    ) AS rn
  FROM `autopay_group_members` gm
  INNER JOIN `autopay_groups` g ON g.group_id = gm.group_id
  WHERE gm.status = 'active'
) src
LEFT JOIN `autopay_clients` existing
  ON existing.branch_id = src.branch_id AND existing.username = src.username
WHERE src.rn = 1 AND existing.id IS NULL;

DROP TABLE IF EXISTS `autopay_group_members`;
DROP TABLE IF EXISTS `autopay_groups`;
