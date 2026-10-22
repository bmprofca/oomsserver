# Platform settings — Server context

> **Purpose:** Tag when adding or changing an integration URL / key / app-wide value, or when something that used to be in `SERVER/.env` or a one-row config table needs to be admin-managed. Pair with the ADMIN pages **Platform Settings**, **Razorpay Config** and **OTP SMS Config**.

---

## Mental model

```
ADMIN → Settings → Platform Settings   (PUT /admin/platform-settings)        generic, every key
ADMIN → Settings → Razorpay Config     (PUT /admin/razorpay/config, /admin/wallet/gateway-fee)
ADMIN → Settings → OTP SMS Config      (PUT /admin/sms-company/config)
        ↓                                 all three write the same rows
platform_settings table  (setting_key PK, setting_value, is_secret, modify_by, modify_date)
        ↓  loadPlatformSettings() at boot, refreshed ≤60 s, and after every admin save
helpers/platformSettings.js in-memory cache
        ↓  getPlatformSetting(key) (sync) · store.resolve(key) · store.update()
b2Storage · whatsapp (OneChatting) · whatsappWeb · wpSystemWhatsappSendService · whatsappNotification
onesaasUploadService · gst.js · Config.js (Google, invitation link)
razorpayConfig.js → razorpayService.js · walletPaymentConfig.js (gateway fee)
smsOtp.js / smsCompanyConfig.js (OTP SMS) · fast2smsSend.js (API URLs)
```

**Resolution order per key:** database row → `process.env` (legacy fallback, incl. `envAliases`) → built-in default.
Secrets are AES-256-GCM encrypted with `helpers/secretBox.js` and are returned to the admin UI only as a masked hint.

The former one-row tables `razorpay_platform_config` and `sms_company_fast2sms_config` **no longer exist**; `scripts/migrate-platform-settings.js` copied their last row into these keys and dropped them. Do not recreate them.

## `.env` is now only

| Group | Keys |
|-------|------|
| Database | `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT`, `DB_CONNECT_TIMEOUT`, `DB_QUERY_RETRIES`, `DB_QUERY_RETRY_DELAY_MS` |
| Application | `APP_NAME`, `BASE_DOMAIN` |
| Push | `FIREBASE_SERVICE_ACCOUNT_PATH` |
| Local dev | `DISABLE_BACKGROUND_JOBS` |

Optional, still read from env if present: `PORT` (default 8877), `APP_ENCRYPTION_KEY` / `SMTP_ENCRYPTION_KEY` (**set one in production**; they decrypt every stored secret, so they cannot live in the database), `FIREBASE_SERVICE_ACCOUNT_KEY`, `MEDIA_PROXY_BASE_DOMAIN`.

## Keys managed in the database

| Group | Key | Type | Used by |
|-------|-----|------|---------|
| application | `GOOGLE_CLIENT_ID` | text | `routes/auth.js` Google sign-in (`getGoogleClientId()` in `helpers/Config.js`) |
| | `BASE_INVITATION_LINK` | url | staff / admin invitations (`getInvitationBaseLink()`) |
| | `TAX_RATE` | number | `helpers/gst.js` → `getTaxRate()` |
| storage | `B2_BUCKET`, `B2_ACCESS_KEY` 🔒, `B2_SECRET_KEY` 🔒, `B2_DOWNLOAD_AUTH_TTL_SECONDS` | | `helpers/b2Storage.js`; `testB2Connection()` backs the admin "Test connection" button |
| razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` 🔒, `RAZORPAY_WEBHOOK_SECRET` 🔒, `RAZORPAY_WEBHOOK_URL`, `RAZORPAY_STATUS` (active/inactive) | | `helpers/razorpayConfig.js` → `services/razorpayService.js`, `routes/webhook.js`. Environment (test/live) is detected from the key prefix |
| | `RAZORPAY_GATEWAY_FEE_PERCENT`, `RAZORPAY_GATEWAY_FEE_FLAT` | number | `helpers/walletPaymentConfig.js` `getGatewayFeeSettings()` / `updateGatewayFeeSettings()` |
| otp_sms | `FAST2SMS_API_URL`, `FAST2SMS_WALLET_URL` | url | `helpers/fast2smsSend.js` (all Fast2SMS sends, incl. branch and system SMS) |
| | `FAST2SMS_AUTH_TOKEN` 🔒, `FAST2SMS_SENDER_ID`, `FAST2SMS_ENTITY_ID`, `SMS_OTP_ROUTE` (dlt/dlt_manual/otp/q), `SMS_OTP_DLT_TEMPLATE_ID`, `SMS_OTP_STATUS` | | `helpers/smsOtp.js` (`resolveCompanySmsConfig()`), admin CRUD in `helpers/smsCompanyConfig.js` |
| onechatting | `ONECHATTING_BASE_URL`, `ONECHATTING_SYSTEM_DEVELOPER_TOKEN` 🔒, `ONECHATTING_PROJECT_DEVELOPER_TOKEN` 🔒 | | `routes/whatsapp.js`, `helpers/whatsappNotification.js`, `services/wpSystemWhatsappSendService.js` |
| whatsapp_web | `WHATSAPPWEB_BASE_URL`, `WHATSAPPWEB_API_KEY` 🔒 | | `helpers/whatsappWeb.js` |
| onesaas | `ONESAAS_UPLOAD_URL`, `ONESAAS_UPLOAD_KEY` 🔒 | | `services/onesaasUploadService.js` |

Other platform credentials keep their own tables and admin pages: company SMTP (`email_company_smtp_config`), System SMS (`sms_system_fast2sms_config`), PBX, LiveKit, help & support, website contact.

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/admin/platform-settings` | `{ groups: [{ key, label, description, fields: [...] }] }`; secret fields have `masked`, `has_value`, never `value`; select fields carry `options` |
| PUT | `/admin/platform-settings` | `{ values: { KEY: value }, clear: ["KEY"] }`. Blank secret = keep. Validates url / number ranges / select options / key-id prefix |
| POST | `/admin/platform-settings/test/b2` | Authorises with saved B2 keys and finds the bucket |
| GET / PUT | `/admin/razorpay/config`, POST `/admin/razorpay/test` | Same payload as before (`key_id`, `key_secret`, `webhook_secret`, `webhook_url`, `status`); now backed by the RAZORPAY_* rows |
| GET / PUT | `/admin/wallet/gateway-fee` | `gateway_fee_percent`, `gateway_fee_flat` → RAZORPAY_GATEWAY_FEE_* |
| GET / PUT | `/admin/sms-company/config` | OTP Fast2SMS (`auth_token` blank = keep); backed by FAST2SMS_* / SMS_OTP_* rows |

## Adding a new setting

1. Add a definition to `PLATFORM_SETTING_DEFS` in `helpers/platformSettings.js` (key, group, label, type `text|url|secret|number|select`, default, description; `options` for select, `envAliases` for extra legacy env names, `validate(value)` for a custom rule). Add a group to `PLATFORM_SETTING_GROUPS` if needed.
2. Read it with `getPlatformSetting(key)` **at call time**, never at module load (module-level constants freeze the boot-time value).
3. The ADMIN Platform Settings page renders definitions generically; no UI change is needed.

## Migration from an existing `.env` / legacy tables

```sh
npm run migrate:platform-settings -- --dry-run      # report only
npm run migrate:platform-settings                   # copy legacy tables + .env → platform_settings, verify, drop legacy tables
npm run migrate:platform-settings -- --force        # also overwrite values already in the DB
npm run migrate:platform-settings -- --keep-tables  # copy + verify, leave the legacy tables
```

Then delete the moved lines from `.env`. The table is also created on first use (`CREATE TABLE IF NOT EXISTS`), SQL in `database/migrations/20261022_platform_settings.sql`.

## Do not

- Put `APP_ENCRYPTION_KEY` / `SMTP_ENCRYPTION_KEY` or `DB_*` into this table (they are needed before the table can be read).
- Read `process.env.RAZORPAY_*`, `FAST2SMS_*`, `SMS_OTP_*`, `B2_*`, `ONECHATTING_*`, `WHATSAPPWEB_*`, `ONESAAS_*`, `TAX_RATE`, `GOOGLE_CLIENT_ID`, `BASE_INVITATION_LINK` directly anywhere.
- Log or return decrypted secrets; use `describe()` for the UI.

Tests: `tests/platformSettings.test.js` (fake pool, resolution order, masking, validation, cache refresh, Razorpay / OTP SMS adapters).
