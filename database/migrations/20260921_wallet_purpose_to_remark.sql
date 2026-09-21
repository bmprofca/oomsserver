-- Rename wallet_transactions.purpose → remark
-- Rename razorpay_orders.purpose → remark (wallet checkout notes)

ALTER TABLE `wallet_transactions`
  CHANGE COLUMN `purpose` `remark` VARCHAR(255) NULL;

ALTER TABLE `razorpay_orders`
  CHANGE COLUMN `purpose` `remark` VARCHAR(255) NULL;
