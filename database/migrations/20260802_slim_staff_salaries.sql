-- Slim staff_salaries to columns used by current salary + attendance logic.
-- 1) Convert expected/monthly from hours → minutes
-- 2) Drop unused rate / allowance / deduction columns

ALTER TABLE staff_salaries
  ADD COLUMN expected_minutes INT NULL COMMENT 'Fixed: expected daily work minutes' AFTER working_hours_end,
  ADD COLUMN monthly_working_minutes INT NULL COMMENT 'Flexible: monthly work minutes' AFTER expected_minutes;

UPDATE staff_salaries
SET expected_minutes = CASE
      WHEN expected_hours IS NULL THEN NULL
      ELSE ROUND(expected_hours * 60)
    END,
    monthly_working_minutes = CASE
      WHEN monthly_working_hours IS NULL THEN NULL
      ELSE ROUND(monthly_working_hours * 60)
    END;

ALTER TABLE staff_salaries
  DROP COLUMN monthly_working_hours,
  DROP COLUMN expected_hours,
  DROP COLUMN overtime_rate_type,
  DROP COLUMN fine_rate_type,
  DROP COLUMN break_excess_penalty_type,
  DROP COLUMN break_excess_penalty_value,
  DROP COLUMN travel_allowance_type,
  DROP COLUMN travel_allowance_value,
  DROP COLUMN other_deduction_type,
  DROP COLUMN other_deduction_value;
