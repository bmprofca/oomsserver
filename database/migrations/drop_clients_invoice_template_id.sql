-- Per-branch formats live in `invoice_formats`; remove per-client column.
ALTER TABLE `clients` DROP COLUMN `invoice_template_id`;
