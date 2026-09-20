-- Remove task/compliance agent assignment columns and agent margin table.
-- Agent party_type remains on transactions for historical finance data.

DROP TABLE IF EXISTS `agent_margin`;

ALTER TABLE `tasks`
    DROP COLUMN `has_agent`,
    DROP COLUMN `agent_id`,
    DROP COLUMN `agent_billing_type`,
    DROP COLUMN `agent_percentage`;

ALTER TABLE `compliance_firms`
    DROP COLUMN `agent`;

ALTER TABLE `clients`
    DROP COLUMN `agent`;

ALTER TABLE `service_requests`
    DROP COLUMN `agent`;
