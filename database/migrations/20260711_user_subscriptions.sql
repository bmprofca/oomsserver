-- Multiple concurrent subscription plans per user with per-plan expiry

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  subscription_row_id VARCHAR(50) NOT NULL,
  username VARCHAR(100) NOT NULL,
  plan_name ENUM('Business','BusinessPlus','BusinessPro') NOT NULL,
  billing_cycle ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  expires_at DATETIME NOT NULL,
  payment_ref VARCHAR(255) DEFAULT NULL,
  payment_method VARCHAR(50) DEFAULT NULL,
  status ENUM('active','expired') NOT NULL DEFAULT 'active',
  create_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modify_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY subscription_row_id (subscription_row_id),
  UNIQUE KEY uk_user_subscriptions_user_plan (username, plan_name),
  KEY idx_user_subscriptions_username (username),
  KEY idx_user_subscriptions_expires (expires_at)
);

-- Migrate legacy single-plan rows from users table
INSERT INTO user_subscriptions (
  subscription_row_id,
  username,
  plan_name,
  billing_cycle,
  expires_at,
  payment_ref,
  payment_method,
  status
)
SELECT
  CONCAT('LEGACY_', u.username, '_', u.subscription_plan),
  u.username,
  u.subscription_plan,
  'monthly',
  u.subscription_expires_at,
  u.razorpay_subscription_id,
  'legacy',
  CASE
    WHEN u.subscription_expires_at IS NOT NULL AND u.subscription_expires_at > NOW() THEN 'active'
    ELSE 'expired'
  END
FROM users u
WHERE u.is_subscribed = 'yes'
  AND u.subscription_plan IN ('Business', 'BusinessPlus', 'BusinessPro')
  AND u.subscription_expires_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_subscriptions us
    WHERE us.username = u.username AND us.plan_name = u.subscription_plan
  );
