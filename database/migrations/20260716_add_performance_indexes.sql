-- Performance indexes for task list, reports, invoices, transactions, etc.
-- Prefer the idempotent runner:
--   node database/scripts/add-performance-indexes.js

-- tasks
ALTER TABLE `tasks` ADD INDEX `idx_tasks_task_id` (`task_id`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_task` (`branch_id`, `task_id`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_created` (`branch_id`, `create_date`, `id`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_status_due` (`branch_id`, `status`, `due_date`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_service` (`branch_id`, `service_id`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_firm` (`branch_id`, `firm_id`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_username` (`branch_id`, `username`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_branch_billing` (`branch_id`, `billing_status`, `status`);
ALTER TABLE `tasks` ADD INDEX `idx_tasks_invoice` (`invoice_id`);

-- task_staffs
ALTER TABLE `task_staffs` ADD INDEX `idx_task_staffs_branch_user` (`branch_id`, `username`, `is_deleted`);
ALTER TABLE `task_staffs` ADD INDEX `idx_task_staffs_task` (`task_id`, `branch_id`, `is_deleted`);
ALTER TABLE `task_staffs` ADD INDEX `idx_task_staffs_assign` (`assign_id`);

-- invoice
ALTER TABLE `invoice` ADD INDEX `idx_invoice_invoice_id` (`invoice_id`);
ALTER TABLE `invoice` ADD INDEX `idx_invoice_branch_invoice` (`branch_id`, `invoice_id`);
ALTER TABLE `invoice` ADD INDEX `idx_invoice_branch_created` (`branch_id`, `create_date`);
ALTER TABLE `invoice` ADD INDEX `idx_invoice_branch_type_created` (`branch_id`, `type`, `create_date`);

-- transactions
ALTER TABLE `transactions` ADD INDEX `idx_txn_branch_date` (`branch_id`, `transaction_date`);
ALTER TABLE `transactions` ADD INDEX `idx_txn_branch_invoice` (`branch_id`, `invoice_id`);
ALTER TABLE `transactions` ADD INDEX `idx_txn_branch_txnid` (`branch_id`, `transaction_id`);
ALTER TABLE `transactions` ADD INDEX `idx_txn_branch_type_date` (`branch_id`, `transaction_type`, `transaction_date`);
ALTER TABLE `transactions` ADD INDEX `idx_txn_party1` (`branch_id`, `party1_type`, `party1_id`, `transaction_date`);
ALTER TABLE `transactions` ADD INDEX `idx_txn_party2` (`branch_id`, `party2_type`, `party2_id`, `transaction_date`);

-- sale_entries / sale_items
ALTER TABLE `sale_entries` ADD INDEX `idx_sale_entries_branch_invoice` (`branch_id`, `invoice_id`);
ALTER TABLE `sale_entries` ADD INDEX `idx_sale_entries_invoice` (`invoice_id`);
ALTER TABLE `sale_entries` ADD INDEX `idx_sale_entries_sale` (`sale_id`);
ALTER TABLE `sale_entries` ADD INDEX `idx_sale_entries_branch_firm` (`branch_id`, `firm_id`);
ALTER TABLE `sale_items` ADD INDEX `idx_sale_items_branch_invoice` (`branch_id`, `invoice_id`);
ALTER TABLE `sale_items` ADD INDEX `idx_sale_items_invoice` (`invoice_id`);
ALTER TABLE `sale_items` ADD INDEX `idx_sale_items_sale` (`sale_id`);

-- branch_services
ALTER TABLE `branch_services` ADD INDEX `idx_branch_services_lookup` (`branch_id`, `service_id`, `is_deleted`);

-- compliance
ALTER TABLE `compliance_schedules` ADD INDEX `idx_cs_assignment_status_due` (`assignment_id`, `status`, `due_date`);
ALTER TABLE `compliance_schedules` ADD INDEX `idx_cs_due_status` (`due_date`, `status`);
ALTER TABLE `compliance_schedules` ADD INDEX `idx_cs_invoice` (`invoice_id`);
ALTER TABLE `compliance_assignments` ADD INDEX `idx_ca_service` (`service_id`);
ALTER TABLE `compliance_assignments` ADD INDEX `idx_ca_employee` (`employee_username`);
ALTER TABLE `compliance_firms` ADD INDEX `idx_cf_branch_service` (`branch_id`(64), `service_id`(64), `is_deleted`);
ALTER TABLE `compliance_firms` ADD INDEX `idx_cf_branch_firm` (`branch_id`(64), `firm_id`(64), `is_deleted`);

-- notes / subtask
ALTER TABLE `notes` ADD INDEX `idx_notes_note_id` (`note_id`);
ALTER TABLE `notes` ADD INDEX `idx_notes_task` (`task_id`, `note_type`, `is_deleted`);
ALTER TABLE `notes` ADD INDEX `idx_notes_branch_task` (`branch_id`, `note_type`, `task_id`, `is_deleted`);
ALTER TABLE `subtask` ADD INDEX `idx_subtask_id` (`subtask_id`);
ALTER TABLE `subtask` ADD INDEX `idx_subtask_task` (`task_id`, `branch_id`, `is_deleted`);
ALTER TABLE `subtask` ADD INDEX `idx_subtask_branch_task` (`branch_id`, `task_id`, `is_deleted`);

-- branch_mapping / profile
ALTER TABLE `branch_mapping` ADD INDEX `idx_bm_branch_user` (`branch_id`, `username`, `is_deleted`);
ALTER TABLE `branch_mapping` ADD INDEX `idx_bm_branch_active` (`branch_id`, `is_deleted`, `status`, `is_accepted`);
ALTER TABLE `branch_mapping` ADD INDEX `idx_bm_username` (`username`, `branch_id`);
ALTER TABLE `profile` ADD INDEX `idx_profile_username` (`username`);
ALTER TABLE `profile` ADD INDEX `idx_profile_type_status` (`user_type`, `status`);
