-- Per-branch PDF theme for expense vouchers (matches `invoice.type` = 'expense').
ALTER TABLE `invoice_formats`
    ADD COLUMN `expense` VARCHAR(32) NOT NULL DEFAULT 'classic' AFTER `contra`;
