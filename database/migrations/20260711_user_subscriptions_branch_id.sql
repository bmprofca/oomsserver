-- Scope subscriptions to branch_id and rename subscription_row_id -> subscription_id

ALTER TABLE user_subscriptions
  ADD COLUMN branch_id VARCHAR(50) NULL AFTER subscription_row_id;

UPDATE user_subscriptions us
INNER JOIN (
  SELECT username, MIN(branch_id) AS branch_id
  FROM branch_mapping
  WHERE type = 'admin'
    AND is_deleted = '0'
  GROUP BY username
) bm ON bm.username = us.username
SET us.branch_id = bm.branch_id
WHERE us.branch_id IS NULL;

ALTER TABLE user_subscriptions
  CHANGE COLUMN subscription_row_id subscription_id VARCHAR(50) NOT NULL;

ALTER TABLE user_subscriptions
  DROP INDEX uk_user_subscriptions_user_plan;

ALTER TABLE user_subscriptions
  ADD UNIQUE KEY uk_user_subscriptions_branch_plan (branch_id, plan_name);

ALTER TABLE user_subscriptions
  ADD KEY idx_user_subscriptions_branch_id (branch_id);

DELETE FROM user_subscriptions WHERE branch_id IS NULL;

ALTER TABLE user_subscriptions
  MODIFY COLUMN branch_id VARCHAR(50) NOT NULL;

ALTER TABLE razorpay_orders
  ADD COLUMN branch_id VARCHAR(50) NULL AFTER username;

UPDATE razorpay_orders ro
INNER JOIN (
  SELECT username, MIN(branch_id) AS branch_id
  FROM branch_mapping
  WHERE type = 'admin'
    AND is_deleted = '0'
  GROUP BY username
) bm ON bm.username COLLATE utf8mb4_unicode_ci = ro.username COLLATE utf8mb4_unicode_ci
SET ro.branch_id = bm.branch_id
WHERE ro.branch_id IS NULL;
