# Client balance lists (debtors / creditors) — Server context

> **Purpose:** Tag when changing dashboard debtors/creditors APIs, balance SQL, or PAN on those lists. Pair with [`CLIENT/context/client-profile.md`](../../CLIENT/context/client-profile.md) and debtors UI in `quick-stats-details.js`.

---

## Mental model

```
transactions effects (party1 / party2 client)
        ↓
helpers/clientBalanceSql.js  →  debtor (balance > 0) / creditor (balance < 0)
        ↓
GET /report/dashboard/details?type=debtors|creditors
```

**Route:** `SERVER/routes/report.js` — `case "debtors"` / `case "creditors"`  
**SQL helpers:** `SERVER/helpers/clientBalanceSql.js`

---

## List response fields (per row)

| Field | Notes |
|-------|--------|
| `username`, `name`, `guardian_name`, `care_of` | From `profile` |
| `pan_number` | Client PAN from `profile.pan_number` (required for UI under guardian) |
| `mobile`, `email`, `country_code` | |
| `firms` / `firm` | Via `getFirmsMapForUsernames`; firm may have `pan_no` (firm PAN — different from client `pan_number`) |
| `balance` | Debtor: positive; creditor: negative |
| `last_transaction` | Debtors only (`date`, `days_ago`, `period`) |

### SQL

`clientBalanceListSql` must `SELECT MAX(p.pan_number) AS pan_number`.  
Search `HAVING` also matches `p.pan_number` (9 search params when search is set).

---

## Client UI expectation

`CLIENT/src/DashboardComponents/quick-stats-details.js` shows under the name:

```
guardian_name
PAN: {pan_number}   // only if present
```

Same pattern as `client-view.jsx`.

---

## Do not confuse

- **`pan_number`** = client profile PAN  
- **`firm.pan_no` / `firms[].pan_no`** = firm business PAN
