-- Normalize email_static_templates.template_type to Title Case labels (no underscores).
UPDATE `email_static_templates`
SET `template_type` = CASE
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN ('payment reminder')
    THEN 'Payment Reminder'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN ('task create')
    THEN 'Task Create'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN ('payment')
    THEN 'Payment'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN (
    'payment receive', 'payment receipt', 'receive', 'received'
  ) THEN 'Payment Receive'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN ('task complete')
    THEN 'Task Complete'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN (
    'document share', 'document sharing'
  ) THEN 'Document Share'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN (
    'birthday wish', 'birthday reminder', 'birthday'
  ) THEN 'Birthday Wish'
  WHEN LOWER(REPLACE(REPLACE(TRIM(`template_type`), '_', ' '), '-', ' ')) IN ('task cancel')
    THEN 'Task Cancel'
  ELSE TRIM(REPLACE(REPLACE(`template_type`, '_', ' '), '-', ' '))
END
WHERE `template_type` IS NOT NULL AND TRIM(`template_type`) <> '';
