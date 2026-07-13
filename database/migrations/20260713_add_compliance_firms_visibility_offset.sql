-- Period list visibility: <0 show from period start; >=0 show from due-month start
ALTER TABLE compliance_firms
  ADD COLUMN visibility_offset INT NOT NULL DEFAULT 0
  COMMENT 'Period list visibility: <0 show from period start; >=0 show from due-month start';
