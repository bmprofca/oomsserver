-- Update existing Outsource statuses to Cancel
UPDATE compliance_schedules SET status = 'Cancel' WHERE status = 'Outsource';

-- Modify the status column ENUM definition in compliance_schedules table
ALTER TABLE compliance_schedules MODIFY COLUMN status ENUM('Pending From The Department','Pending From Client','N/A','Complete','Cancel') NOT NULL DEFAULT 'Pending From The Department';
