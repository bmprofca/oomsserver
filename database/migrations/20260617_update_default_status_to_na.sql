-- Alter status column in compliance_schedules table to change the default value to 'N/A'
ALTER TABLE compliance_schedules MODIFY COLUMN status ENUM('Pending From The Department','Pending From Client','N/A','Complete','Cancel') NOT NULL DEFAULT 'N/A';
