# Group firms — Server context

> **Purpose:** Tag when changing group firm list, balances, last payment, bulk reminder clients, or group details. Pair with [`CLIENT/context/group-firms.md`](../../CLIENT/context/group-firms.md).

---

## Mental model

```
groups (branch-scoped)
   └── group_firms → firms → profile (client)
              ↓
   balance + last payment (batch per page usernames)
```

**Routes:** `SERVER/routes/group.js`  
**Balance SQL:** `SERVER/helpers/clientBalanceSql.js` (`CLIENT_BALANCE_EFFECTS_SQL`, `CLIENT_LAST_PAYMENT_SQL`)

---

## Endpoints

| Method | Path | Notes |
|--------|------|------|
| GET | `/group/details/:group_id` | Lightweight meta + `firm_count`; **404** if not in branch |
| GET | `/group/group-firms/list` | Paginated firms + client balance + `last_payment` |
| GET | `/group/group-firms/debtor-clients` | Unique clients in group with `balance > 0.02` (bulk reminder) |
| POST | `/group/group-firms/add-firms` | Add firms to group |
| DELETE | `/group/group-firms/remove` | Soft-remove; supports `is_all` + `search` |

All require `auth` + `validateBranch` (`branch` header).

---

## Group details response

```json
{
  "success": true,
  "data": {
    "group": {
      "group_id": "...",
      "group_name": "...",
      "group_remark": "",
      "status": "1",
      "is_active": true,
      "firm_count": 12
    }
  }
}
```

404 body includes `code: "GROUP_NOT_FOUND"`.

---

## List search — placeholder count

Search builds N `LIKE ?` clauses; bind **exactly N** patterns (currently **21** fields).  
A mismatch shifts params into `LIMIT` (MariaDB parse error like `LIMIT '%say%'`).

Same count applies to bulk-remove `is_all` + search.

---

## List client payload (per firm)

```js
client: {
  username, name, guardian_name, care_of, mobile, email, country_code, pan_number,
  balance,                    // GET_BALANCE-style effects for branch
  last_payment: { date, period }  // receive/received MAX(transaction_date); period label
}
```

`period`: `No payment` | `Today` | `Last 7 days` | `Last 30 days` | `Last 90 days` | `90+ days`.

---

## Debtor clients (bulk reminder)

`GET /group/group-firms/debtor-clients?group_id=&search=`

- Respects optional search (same firm/profile fields as list).
- Returns `{ clients: [{ username, name, mobile, email, country_code, balance }] }` with `balance > 0`.
- Do **not** use branch-wide `is_all` payment reminder for a group — always pass explicit `usernames`.
