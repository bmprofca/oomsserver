-- journal_entries: replace from_username / to_username with party type + id columns
-- (aligns with transactions.party1_* / party2_* for any party type)

ALTER TABLE journal_entries
  ADD COLUMN party1_type VARCHAR(100) NULL DEFAULT NULL AFTER transaction_date,
  ADD COLUMN party1_id VARCHAR(100) NULL DEFAULT NULL AFTER party1_type,
  ADD COLUMN party2_type VARCHAR(100) NULL DEFAULT NULL AFTER party1_id,
  ADD COLUMN party2_id VARCHAR(100) NULL DEFAULT NULL AFTER party2_type;

-- Prefer linked transaction row (authoritative party types/ids)
UPDATE journal_entries je
INNER JOIN transactions t
  ON t.transaction_id = je.transaction_id
 AND t.branch_id = je.branch_id
SET je.party1_type = t.party1_type,
    je.party1_id = t.party1_id,
    je.party2_type = t.party2_type,
    je.party2_id = t.party2_id;

-- Fallback for rows without a matching transaction: legacy usernames as client parties
UPDATE journal_entries
SET party1_type = COALESCE(party1_type, 'client'),
    party1_id = COALESCE(party1_id, from_username),
    party2_type = COALESCE(party2_type, 'client'),
    party2_id = COALESCE(party2_id, to_username)
WHERE from_username IS NOT NULL
   OR to_username IS NOT NULL;

ALTER TABLE journal_entries
  DROP COLUMN from_username,
  DROP COLUMN to_username;
