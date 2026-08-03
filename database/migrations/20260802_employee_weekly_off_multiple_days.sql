-- Allow multiple paid day-off weekdays per staff (drop single-row unique)

ALTER TABLE employee_weekly_off
  DROP INDEX unique_employee_weekly_off;

ALTER TABLE employee_weekly_off
  ADD KEY idx_employee_weekly_off_user_branch_day (username, branch_id, weekly_off_day);
