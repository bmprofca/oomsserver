-- Overtime / fine fields for manage attendance mark & bulk approve.
-- Prefer: node database/scripts/add-attendance-overtime-fine.js (idempotent).
-- Amounts: daily_wage = monthly_amount / days_in_month;
-- per_hour = daily_wage / expected_hours; OT/fine = (extra|less minutes / 60) * per_hour.

ALTER TABLE attendance
  ADD COLUMN expected_hours DECIMAL(5,2) NULL COMMENT 'Snapshot from staff_salaries for this mark' AFTER out_time,
  ADD COLUMN worked_minutes INT NULL COMMENT 'Punch duration in minutes' AFTER expected_hours,
  ADD COLUMN extra_minutes INT NULL DEFAULT 0 COMMENT 'Minutes over expected_hours' AFTER worked_minutes,
  ADD COLUMN less_minutes INT NULL DEFAULT 0 COMMENT 'Minutes under expected_hours' AFTER extra_minutes,
  ADD COLUMN overtime_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = OT amount applied' AFTER less_minutes,
  ADD COLUMN fine_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = fine amount applied' AFTER overtime_enabled,
  ADD COLUMN daily_wage DECIMAL(12,2) NULL COMMENT 'Monthly amount / days in month' AFTER fine_enabled,
  ADD COLUMN overtime_amount DECIMAL(12,2) NULL DEFAULT 0.00 AFTER daily_wage,
  ADD COLUMN fine_amount DECIMAL(12,2) NULL DEFAULT 0.00 AFTER overtime_amount,
  ADD COLUMN net_day_amount DECIMAL(12,2) NULL COMMENT 'daily_wage + overtime_amount - fine_amount' AFTER fine_amount;
