-- Clear auto-generated CA purchase remarks from transactions.
-- Pattern was: "CA purchase for task <task_id>"

UPDATE transactions
SET remark = NULL
WHERE remark LIKE 'CA purchase for task %';
