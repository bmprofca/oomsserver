-- Remove type column from transactions table.
-- Convention: party1_id/party1_type = sender, party2_id/party2_type = receiver.
-- For two-party transactions: sender effect = -amount, receiver effect = +amount.
-- For opening balance (party2 is NULL): amount sign indicates direction (positive = debit, negative = credit).

-- Step 1: Migrate opening balance rows - convert type=1 (credit) to negative amount
UPDATE transactions
SET amount = -ABS(amount)
WHERE transaction_type = 'opening balance' AND type = '1';

-- Step 2: Drop the type column
ALTER TABLE transactions DROP COLUMN type;
