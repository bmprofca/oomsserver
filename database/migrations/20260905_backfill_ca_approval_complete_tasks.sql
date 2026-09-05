-- Backfill: existing completed tasks should not appear in the new CA approval / UDIN workflow.
-- Feature applies going forward to non-complete tasks only.
UPDATE tasks
SET ca_approval = 'complete'
WHERE LOWER(TRIM(status)) = 'complete'
  AND has_ca = '1'
  AND (ca_approval IS NULL OR ca_approval <> 'complete');
