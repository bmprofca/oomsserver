-- Support subscription and wallet Razorpay orders in one table

ALTER TABLE razorpay_orders
  ADD COLUMN order_type VARCHAR(20) NOT NULL DEFAULT 'subscription' AFTER billing_cycle;

ALTER TABLE razorpay_orders
  ADD COLUMN purpose VARCHAR(255) NULL AFTER order_type;

ALTER TABLE razorpay_orders
  ADD COLUMN details TEXT NULL AFTER purpose;

UPDATE razorpay_orders
SET order_type = 'subscription'
WHERE order_type IS NULL OR order_type = '';

UPDATE razorpay_orders
SET order_type = 'wallet'
WHERE razorpay_order_id LIKE 'wallet_%'
   OR plan_name IS NULL
   OR plan_name = 'WalletTopup';
