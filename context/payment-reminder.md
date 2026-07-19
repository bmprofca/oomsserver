# Client payment reminder — Server context

> **Purpose:** Tag when changing payment reminder send logic or eligibility. Pair with [`CLIENT/context/payment-reminder.md`](../../CLIENT/context/payment-reminder.md).

---

## Endpoint

| Method | Path | Auth |
|--------|------|------|
| POST | `/client/payment-reminder` | branch headers (`auth` + `validateBranch`) |

**File:** `SERVER/routes/client.js`

---

## Body

```json
{
  "usernames": ["user1", "user2"],
  "is_all": false,
  "channels": ["whatsapp", "email", "sms"]
}
```

| Mode | Behavior |
|------|----------|
| `usernames[]` | Remind only listed usernames (branch clients) |
| `is_all: true` | Ignore `usernames`; load all active branch clients, then still **skip non-debit** |

---

## Eligibility (server-enforced)

- Client must belong to current `branch_id`, active, not deleted.
- Must have **debit balance** (positive receivable). Non-debit → `skipped` in results.
- Do not trust the client UI alone — always re-check balance server-side.

---

## Response shape (summary)

Returns per-client / aggregate status such as `sent` / `partial` / `skipped` / `failed` plus `details` array. Channels attempted according to request + availability.

---

## Do not

- Send reminders for credit or zero balance
- Require only email; multi-channel is intentional
