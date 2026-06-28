-- Move remark from invoice to transactions table
-- 1. Add remark column to transactions
ALTER TABLE transactions ADD COLUMN remark VARCHAR(500) NULL DEFAULT NULL;

-- 2. Copy existing remark from invoice to transactions (where linked)
UPDATE transactions t
INNER JOIN invoice i ON i.transaction_id = t.transaction_id
SET t.remark = i.remark
WHERE i.remark IS NOT NULL AND i.remark != '';

-- 3. Drop remark from invoice
ALTER TABLE invoice DROP COLUMN remark;
