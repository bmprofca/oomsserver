# OOMS System SMS — Server context

> **Purpose:** Platform-owned Fast2SMS channel for branches that do not have their own DLT / Fast2SMS account. Separate from OTP company SMS (`sms_company_fast2sms_config`).

---

## Channel

`branch_list.sms_channel = ooms system`

Other values: `disabled` | `fast2sms`.

---

## Platform config

Table: `sms_system_fast2sms_config` (admin-managed; not OTP config).

Admin: **Settings → System SMS Config** (`/admin/sms-system/config`).

Send helper: `resolveSystemSmsConfigForSend()` in `helpers/smsSystemConfig.js`.

---

## Templates

Table: `sms_system_templates`

- `type` from `SMS_TEMPLATELIST` or `campaign`
- `dlt_message_id`, `message_body` with `{#var#}`
- `variable_keys` JSON — OOMS keys in DLT order (e.g. `["{{name}}","{{amount}}"]`)

Admin: **Settings → System SMS Templates**.

---

## Branch mapping

Table: `sms_system_template_mapping` — `type` → `sms_template_id`.

CLIENT: `/broadcast/sms/system/template` when channel is OOMS System.

APIs under `/api/v1/broadcast/sms/ooms-system/*`.

---

## Notifications

`helpers/smsNotification.js` → `sendMappedFast2Sms`:

- `fast2sms` → branch config + branch templates
- `ooms system` → system config + system mapping/templates

Availability: `checkSmsAvailability` in `routes/utils.js`.

---

## Campaigns

Reuse `sms_fast2sms_campaigns` / schedules with `channel_source = ooms_system`.

CLIENT campaign pages are shared; path `/broadcast/sms/ooms-system/...` selects system APIs via `smsApi.forMode('ooms_system')`.
