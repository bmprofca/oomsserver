# Server context docs

Modular agent playbooks for the OOMS API. Tag the relevant file(s) instead of re-explaining.

## Files

| File | When to tag |
|------|-------------|
| [`subscription.md`](./subscription.md) | Branch `user_subscriptions`, activate/replace plans, admin manual assign, middleware |
| [`group-firms.md`](./group-firms.md) | Group details, firm list search/balance/last payment, debtor-clients for reminders |
| [`client-balance.md`](./client-balance.md) | Debtors/creditors dashboard APIs, `clientBalanceSql`, client `pan_number` on lists |
| [`payment-reminder.md`](./payment-reminder.md) | `POST /client/payment-reminder`, debit eligibility, channels |
| [`birthday-reminder.md`](./birthday-reminder.md) | `POST /client/birthday-reminder`, availability aliases, WhatsApp `{{…}}` only |
| [`task-list.md`](./task-list.md) | `/task/list` + report payloads: `complete_date`, compliance fields |
| [`gst-change.md`](./gst-change.md) | Branch GST, tax rates, fees/totals, dropped tax columns, `helpers/gst.js` |
| [`firm-delete.md`](./firm-delete.md) | Soft-delete firm blocked by tasks/sales/docs/compliance/etc. |
| [`account-profile.md`](./account-profile.md) | Logged-in user profile (`/account`), contact OTP, profile image |
| [`utils.md`](./utils.md) | Shared utility routes like `/utils/states-and-districts` |
| [`wp_system.md`](./wp_system.md) | OOMS System WhatsApp channel: JSON templates, mappings, OneChatting send + header image URLs |
| [`attendance.md`](./attendance.md) | Phase-1 punch/break APIs, `username` on `break`, IST timestamps (not MySQL `NOW()`), `breaks[]` |
| [`attendance-removed.md`](./attendance-removed.md) | Legacy notes from attendance removal / pre-rebuild (salary kept on `/salary`) |

## Pair with client

| Server | Client |
|--------|--------|
| `subscription.md` | `CLIENT/context/subscription.md` |
| `group-firms.md` | `CLIENT/context/group-firms.md`, `CLIENT/context/payment-reminder.md` |
| `client-balance.md` | `CLIENT/context/client-profile.md`, `CLIENT/context/ledger-tab.md`, debtors UI |
| `payment-reminder.md` | `CLIENT/context/payment-reminder.md` |
| `birthday-reminder.md` | `CLIENT/context/birthday-reminder.md` |
| `task-list.md` | `CLIENT/context/task-list-display.md` |
| `gst-change.md` | `CLIENT/context/gst-change.md` |
| `account-profile.md` | `CLIENT/context/account-profile.md` |
| `utils.md` | `CLIENT/context/client-create.md` |
| — | `CLIENT/context/layout.md` (shell width; client-only) |
| — | `CLIENT/context/settings-branch.md` (Branch Settings UI + GST Config tab) |
| `attendance.md` | `CLIENT/context/attendance.md` |
