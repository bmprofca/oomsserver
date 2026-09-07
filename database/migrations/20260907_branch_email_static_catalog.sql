-- Branch-owned email: one static notification template per type, no mapping table.
-- Safe to re-run. Duplicate cleanup + catalog seed also run from
-- SERVER/scripts/run_branch_email_static_catalog.js

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS email_static_mapping;
SET FOREIGN_KEY_CHECKS = 1;

-- Remove types that are not in the 7-type catalog
DELETE FROM email_static_templates
WHERE LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) NOT IN (
    'payment reminder',
    'task create',
    'payment',
    'payment receive',
    'task complete',
    'document share',
    'birthday wish'
);

-- Canonical type labels
UPDATE email_static_templates
SET template_type = CASE
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) = 'payment reminder' THEN 'Payment Reminder'
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) = 'task create' THEN 'Task Create'
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) = 'payment' THEN 'Payment'
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) IN ('payment receive', 'payment receipt', 'receive', 'received') THEN 'Payment Receive'
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) = 'task complete' THEN 'Task Complete'
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) IN ('document share', 'document sharing') THEN 'Document Share'
    WHEN LOWER(TRIM(REPLACE(REPLACE(template_type, '_', ' '), '-', ' '))) IN ('birthday wish', 'birthday', 'birthday reminder') THEN 'Birthday Wish'
    ELSE template_type
END;

-- Keep one row per (branch, type): prefer active, then newest
DELETE t1 FROM email_static_templates t1
INNER JOIN email_static_templates t2
  ON t1.branch_id = t2.branch_id
 AND t1.template_type = t2.template_type
 AND (
    (t1.status = 'inactive' AND t2.status = 'active')
    OR (t1.status = t2.status AND t1.id < t2.id)
 );

-- Exactly one template per notification type for a branch
ALTER TABLE email_static_templates
  ADD UNIQUE KEY uniq_email_static_branch_type (branch_id, template_type);
