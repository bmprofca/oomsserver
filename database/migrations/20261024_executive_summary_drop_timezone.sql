-- Executive Summary is India-only: schedules and periods always use Asia/Kolkata
-- (REPORT_TIMEZONE in services/executiveSummaryService.js), so the per-branch
-- timezone setting is no longer read or written. Safe to run after deploying
-- the code that stopped using it.
ALTER TABLE `executive_summary_configs` DROP COLUMN `timezone`;
