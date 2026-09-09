# Fast2SMS notification sends — Server context

> **Purpose:** Tag when changing branch SMS notifications (not OTP). Pair with Fast2SMS Templates UI (`/broadcast/sms/fast2sms/templates`) and [`utils.md`](./utils.md) availability.

---

## Mental model

```
Event (birthday / payment / task / …)
  → helpers/smsNotification.js
  → sms_fast2sms_template_mapping (type → template)
  → sendFast2Sms
```

Core API: `sendMappedFast2Sms({ branch_id, templateType, bracedVariables, mobile|username })`.

---

## Template types (`SMS_TEMPLATELIST`)

| Type | Sender | Call sites |
|------|--------|------------|
| `payment reminder` | `sendPaymentReminderSms` | `client.js`, `autopay.js` |
| `birthday wish` | `sendBirthdayWishSms` | `client.js` birthday reminder |
| `payment receive` | `notifyPaymentReceiveSms` | `transactions.js` (when `notification.sms`) |
| `payment` | `notifyPaymentSms` | `transactions.js` (when `notification.sms`) |
| `task create` | `notifyTaskCreatedSms` | `task.js`, `taskCreateHelper.js` (silent if unmapped) |
| `task complete` | `notifyTaskCompletedSms` | `task.js`, `compliance.js` (silent if unmapped) |

`document sharing` is excluded from SMS (cannot attach files).

---

## Availability

`GET /utils/notification-availability?type=…` → `checkSmsAvailability(branch_id, type)` requires:

1. Branch SMS channel = Fast2SMS  
2. Active Fast2SMS config with auth token  
3. Active mapping + template for that notification type  

---

## Do not

- Assume SMS is available for every type just because Fast2SMS is configured  
- Pass only bare keys into DLT variable resolution — use `toBracedVariables` / `{{key}}` maps  
