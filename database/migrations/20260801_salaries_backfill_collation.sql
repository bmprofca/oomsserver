-- Align collation with legacy staff_salary, then backfill

ALTER TABLE salaries CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE staff_salary_assignments CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO salaries (
  salary_id,
  branch_id,
  salary_type,
  amount,
  monthly_working_hours,
  create_by,
  modify_by,
  create_date,
  modify_date,
  is_deleted,
  deleted_by
)
SELECT
  ss.salary_id,
  ss.branch_id,
  'fixed',
  ss.monthly_salary,
  NULL,
  ss.create_by,
  ss.modify_by,
  ss.create_date,
  ss.modify_date,
  ss.is_deleted,
  ss.deleted_by
FROM staff_salary ss
WHERE NOT EXISTS (
  SELECT 1 FROM salaries s WHERE s.salary_id = ss.salary_id
);

INSERT INTO staff_salary_assignments (
  assignment_id,
  salary_id,
  map_id,
  username,
  branch_id,
  effective_from,
  effective_to,
  is_active,
  working_hours_start,
  working_hours_end,
  expected_hours,
  grace_period_minutes,
  overtime_rate_type,
  fine_rate_type,
  overtime_enabled,
  fine_enabled,
  allowed_break_minutes,
  break_excess_penalty_type,
  break_excess_penalty_value,
  travel_allowance_type,
  travel_allowance_value,
  other_deduction_type,
  other_deduction_value,
  create_by,
  modify_by,
  create_date,
  modify_date,
  is_deleted,
  deleted_by
)
SELECT
  CONCAT('ASN_', ss.salary_id),
  ss.salary_id,
  ss.map_id,
  ss.username,
  ss.branch_id,
  ss.effective_from,
  ss.effective_to,
  ss.is_active,
  ss.working_hours_start,
  ss.working_hours_end,
  ss.expected_hours,
  ss.grace_period_minutes,
  ss.overtime_rate_type,
  ss.fine_rate_type,
  ss.overtime_enabled,
  ss.fine_enabled,
  ss.allowed_break_minutes,
  ss.break_excess_penalty_type,
  ss.break_excess_penalty_value,
  ss.travel_allowance_type,
  ss.travel_allowance_value,
  ss.other_deduction_type,
  ss.other_deduction_value,
  ss.create_by,
  ss.modify_by,
  ss.create_date,
  ss.modify_date,
  ss.is_deleted,
  ss.deleted_by
FROM staff_salary ss
WHERE NOT EXISTS (
  SELECT 1 FROM staff_salary_assignments a WHERE a.salary_id = ss.salary_id
);
