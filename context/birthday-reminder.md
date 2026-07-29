# Birthday reminder — Server context

> **Purpose:** Tag when changing birthday wish send logic, channel availability, or WhatsApp template variables. Pair with [`CLIENT/context/birthday-reminder.md`](../../CLIENT/context/birthday-reminder.md). Related: [`payment-reminder.md`](./payment-reminder.md).

---

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/utils/notification-availability?type=birthday_reminder` | `auth` + `validateBranch` |
| POST | `/client/birthday-reminder` | `auth` + `validateBranch` |

**Files:** `SERVER/routes/utils.js`, `SERVER/routes/client.js`, `SERVER/helpers/whatsappNotification.js`

---

## Body (`POST /client/birthday-reminder`)

```json
{
  "usernames": ["user1", "user2"],
  "is_all": false,
  "channels": ["whatsapp", "email", "sms"]
}
```

| Mode | Behavior |
|------|----------|
| `usernames[]` | Wish only listed clients (branch, active); skip if DOB month/day ≠ today |
| `is_all: true` | Load all active clients whose birthday is **today** |

Max 100 usernames per non-`is_all` request.

---

## Eligibility (server-enforced)

- Client on current `branch_id`, active, not deleted.
- `date_of_birth` month/day must match today → else `skipped` (“Birthday is not today”).
- Do not require debit balance (unlike payment reminder).

---

## Channel templates

Availability normalizes `birthday_reminder` → **`birthday wish`** (WhatsApp system name). Email/SMS also accept aliases: `birthday`, `birthday reminder`, `birthday_wish`, etc. (`notificationTypeCandidates` in `utils.js`).

| Channel | Lookup |
|---------|--------|
| WhatsApp | Template / mapping name **`birthday wish`** → `sendBirthdayWishWhatsapp` |
| Email | `email_static_templates` types: `birthday`, `birthday_reminder`, … |
| SMS | `sms_templates` names: `birthday`, `birthday reminder`, `birthday wish`, … |

---

## Critical: WhatsApp variables

`replaceVariablesInString` **only** substitutes keys shaped like `{{name}}`.

Bare keys such as `age` must **never** be passed into WhatsApp component substitution — they corrupt JSON (`"type":"image"` → `"type":"im1"`), which skips media URL resolution and yields OneChatting **400**.

- Email `renderTemplate` / SMS still use bare keys (`name`, `age`, …).
- `sendBirthdayWishWhatsapp` filters extras via `pickBracedTemplateVariables`.

---

## Response shape

Same idea as payment reminder: `sent` / `partial` / `skipped` / `failed` + `details[]` with per-channel results.

---

## Do not

- Require debit balance for birthday sends
- Spread bare email-style variables into WhatsApp `component` replacement
- Rely on a single template type string without aliases (clients configure `birthday` vs `birthday wish` differently per channel)
