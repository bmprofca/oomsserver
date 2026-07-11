-- wallet_transactions.branch_id: store string branch IDs (e.g. RANDOM_STRING), nullable

ALTER TABLE wallet_transactions
  MODIFY COLUMN branch_id TEXT NULL DEFAULT NULL;
