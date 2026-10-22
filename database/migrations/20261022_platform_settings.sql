-- Platform settings: every integration URL / key / app-wide value that used to be read from
-- SERVER/.env or from the one-row tables razorpay_platform_config and sms_company_fast2sms_config
-- (both removed). Managed from ADMIN → Settings → Platform Settings (plus the Razorpay and
-- OTP SMS pages, which edit the same rows). Secrets are AES-256-GCM encrypted
-- (helpers/secretBox.js, key from APP_ENCRYPTION_KEY / SMTP_ENCRYPTION_KEY).
--
-- Keys (see PLATFORM_SETTING_DEFS in helpers/platformSettings.js):
--   application : GOOGLE_CLIENT_ID, BASE_INVITATION_LINK, TAX_RATE
--   storage     : B2_BUCKET, B2_ACCESS_KEY, B2_SECRET_KEY, B2_DOWNLOAD_AUTH_TTL_SECONDS
--   razorpay    : RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_WEBHOOK_URL,
--                 RAZORPAY_STATUS, RAZORPAY_GATEWAY_FEE_PERCENT, RAZORPAY_GATEWAY_FEE_FLAT
--   otp_sms     : FAST2SMS_API_URL, FAST2SMS_WALLET_URL, FAST2SMS_AUTH_TOKEN, FAST2SMS_SENDER_ID,
--                 FAST2SMS_ENTITY_ID, SMS_OTP_ROUTE, SMS_OTP_DLT_TEMPLATE_ID, SMS_OTP_STATUS
--   onechatting : ONECHATTING_BASE_URL, ONECHATTING_SYSTEM_DEVELOPER_TOKEN, ONECHATTING_PROJECT_DEVELOPER_TOKEN
--   whatsapp_web: WHATSAPPWEB_BASE_URL, WHATSAPPWEB_API_KEY
--   onesaas     : ONESAAS_UPLOAD_URL, ONESAAS_UPLOAD_KEY
--
-- The server also creates this table on first use (helpers/platformSettings.js).
-- One-time data move from the legacy tables / .env: `npm run migrate:platform-settings`
-- (scripts/migrate-platform-settings.js), which also drops the two legacy tables.
CREATE TABLE IF NOT EXISTS `platform_settings` (
  `setting_key` VARCHAR(100) NOT NULL,
  `setting_value` TEXT NULL,
  `is_secret` TINYINT(1) NOT NULL DEFAULT 0,
  `modify_by` VARCHAR(50) NULL DEFAULT NULL,
  `modify_date` DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
