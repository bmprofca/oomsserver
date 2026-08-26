CREATE TABLE IF NOT EXISTS `autopay_clients` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `reminder_id` varchar(50) NOT NULL,
  `branch_id` varchar(50) NOT NULL,
  `username` varchar(100) NOT NULL,
  `schedule_type` enum('daily','weekly','monthly') NOT NULL,
  `schedule_config` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`schedule_config`)),
  `channels` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`channels`)),
  `is_active` tinyint(4) DEFAULT 1,
  `create_by` varchar(100) DEFAULT NULL,
  `modify_by` varchar(100) DEFAULT NULL,
  `create_date` datetime DEFAULT NULL,
  `modify_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `reminder_id` (`reminder_id`),
  UNIQUE KEY `uq_branch_username` (`branch_id`, `username`),
  KEY `idx_branch_active` (`branch_id`, `is_active`),
  KEY `idx_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `autopay_logs`
  MODIFY COLUMN `group_id` varchar(50) NULL;

ALTER TABLE `autopay_logs`
  ADD COLUMN `reminder_id` varchar(50) DEFAULT NULL AFTER `group_id`;

ALTER TABLE `autopay_logs`
  ADD COLUMN `username` varchar(100) DEFAULT NULL AFTER `reminder_id`;

ALTER TABLE `autopay_logs`
  ADD KEY `idx_reminder_id` (`reminder_id`);

ALTER TABLE `autopay_logs`
  ADD KEY `idx_log_username` (`username`);

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
