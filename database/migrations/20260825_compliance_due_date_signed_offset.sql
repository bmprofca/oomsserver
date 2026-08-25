-- Ensure compliance day-offset columns accept negatives (signed INT).
-- due_date / default_due_date = days from period end (+ after, - within period).

ALTER TABLE `services`
  MODIFY COLUMN `default_due_date` INT NULL;

ALTER TABLE `branch_services`
  MODIFY COLUMN `due_date` INT NULL;

ALTER TABLE `compliance_firms`
  MODIFY COLUMN `due_date` INT NULL;
