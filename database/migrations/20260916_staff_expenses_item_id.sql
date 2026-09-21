-- Staff expenses: link to indirect expense item; store linked expense_entries id on approve.

ALTER TABLE `staff_expenses`
  ADD COLUMN `item_id` VARCHAR(100) NULL DEFAULT NULL AFTER `description`,
  ADD COLUMN `linked_expense_id` VARCHAR(100) NULL DEFAULT NULL AFTER `transaction_id`;

ALTER TABLE `staff_expenses`
  ADD KEY `idx_staff_expenses_item` (`branch_id`, `item_id`),
  ADD KEY `idx_staff_expenses_linked` (`branch_id`, `linked_expense_id`);
