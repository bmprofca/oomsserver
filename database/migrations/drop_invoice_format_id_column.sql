-- PDF layout is resolved from `invoice_formats` at generate time; do not persist on `invoice`.
-- If this errors with "Unknown column", the column was never added — skip this file.
-- Legacy installs may still have `template_id` instead: run
--   ALTER TABLE `invoice` DROP COLUMN `template_id`;
ALTER TABLE `invoice` DROP COLUMN `format_id`;
