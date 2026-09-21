-- Gateway fee on Razorpay wallet top-ups + manual payment request banks/requests.

ALTER TABLE `razorpay_platform_config`
  ADD COLUMN `gateway_fee_percent` DECIMAL(8,4) NOT NULL DEFAULT 0
    COMMENT 'Percent fee on net wallet credit (Razorpay only)'
    AFTER `status`,
  ADD COLUMN `gateway_fee_flat` DECIMAL(12,2) NOT NULL DEFAULT 0
    COMMENT 'Flat fee in INR on Razorpay top-ups'
    AFTER `gateway_fee_percent`;

ALTER TABLE `razorpay_orders`
  ADD COLUMN `credit_amount` BIGINT NULL
    COMMENT 'Amount credited to wallet in paise (net of gateway fee)'
    AFTER `amount`,
  ADD COLUMN `gateway_fee` BIGINT NULL
    COMMENT 'Gateway fee in paise charged to payer'
    AFTER `credit_amount`;

CREATE TABLE IF NOT EXISTS `wallet_payment_banks` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `bank_id` VARCHAR(50) NOT NULL,
  `account_name` VARCHAR(150) NOT NULL DEFAULT '',
  `bank_name` VARCHAR(150) NOT NULL DEFAULT '',
  `account_number` VARCHAR(64) NOT NULL DEFAULT '',
  `ifsc` VARCHAR(20) NOT NULL DEFAULT '',
  `branch_name` VARCHAR(150) NULL DEFAULT NULL,
  `upi_id` VARCHAR(100) NULL DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `sort_order` INT NOT NULL DEFAULT 0,
  `create_by` VARCHAR(50) NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wallet_payment_bank_id` (`bank_id`),
  KEY `idx_wallet_payment_banks_status` (`status`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `wallet_payment_requests` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `request_id` VARCHAR(50) NOT NULL,
  `branch_id` VARCHAR(50) NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `bank_id` VARCHAR(50) NULL DEFAULT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `remark` VARCHAR(255) NULL DEFAULT NULL,
  `transfer_ref` VARCHAR(100) NULL DEFAULT NULL COMMENT 'UTR / reference number',
  `transfer_date` DATE NULL DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending|approved|rejected',
  `admin_remark` VARCHAR(500) NULL DEFAULT NULL,
  `reviewed_by` VARCHAR(100) NULL DEFAULT NULL,
  `reviewed_at` DATETIME NULL DEFAULT NULL,
  `create_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wallet_payment_request_id` (`request_id`),
  KEY `idx_wallet_payment_req_branch` (`branch_id`, `status`),
  KEY `idx_wallet_payment_req_status` (`status`, `create_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
