-- Consolidate payment_reminder_logs into autopay_logs, then drop the old table.

INSERT INTO `autopay_logs` (
  `log_id`,
  `reminder_id`,
  `username`,
  `branch_id`,
  `status`,
  `message`,
  `error_message`,
  `details`,
  `sent_count`,
  `skipped_count`,
  `failed_count`,
  `run_date`,
  `completed_at`
)
SELECT
  CONCAT('prl_mig_', LOWER(HEX(RANDOM_BYTES(6)))),
  NULL,
  prl.username,
  prl.branch_id,
  CASE
    WHEN LOWER(COALESCE(prl.status, '')) = 'sent' THEN 'completed'
    WHEN LOWER(COALESCE(prl.status, '')) = 'failed' THEN 'failed'
    WHEN LOWER(COALESCE(prl.status, '')) IN ('pending', 'processing', 'completed', 'failed', 'skipped')
      THEN LOWER(prl.status)
    ELSE 'completed'
  END,
  'Migrated from payment_reminder_logs (manual email reminder)',
  prl.error_message,
  JSON_OBJECT(
    'source', 'payment_reminder_logs',
    'email', prl.email,
    'balance_debit', prl.balance_debit,
    'template_id', prl.template_id,
    'message_id', prl.message_id,
    'legacy_log_id', prl.log_id
  ),
  CASE WHEN LOWER(COALESCE(prl.status, '')) = 'failed' THEN 0 ELSE 1 END,
  0,
  CASE WHEN LOWER(COALESCE(prl.status, '')) = 'failed' THEN 1 ELSE 0 END,
  COALESCE(prl.sent_at, NOW()),
  COALESCE(prl.sent_at, NOW())
FROM `payment_reminder_logs` prl
WHERE NOT EXISTS (
  SELECT 1
  FROM `autopay_logs` al
  WHERE al.branch_id = prl.branch_id
    AND al.username <=> prl.username
    AND JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.legacy_log_id')) = prl.log_id
);

DROP TABLE IF EXISTS `payment_reminder_logs`;
