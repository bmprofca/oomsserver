# Finance Registers (Backend API)

API contracts for finance register screens: **Received report**, **Bank list stats**, and **Discount entries**.

Base path: `/api/v1` (see `routes/index.js`).

Auth: all endpoints use `auth` + `validateBranch` middleware. Branch comes from the `branch` header.

---

## Transactions router (`routes/transactions.js`)

Mounted at: `/transaction`

### `GET /transaction/report/receive`

Paginated received-payment register for invoice type `payment receive`.

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page_no` | number | `1` | Min 1 |
| `limit` | number | `10` | Clamped 1–100 |
| `from_date` | string | `1970-01-01` | `YYYY-MM-DD` |
| `to_date` | string | `2099-12-31` | `YYYY-MM-DD` |
| `search` | string | — | Optional; matches `invoice_no` or `remark` |

**Response**

```json
{
  "success": true,
  "data": [
    {
      "transaction_id": "...",
      "transaction_date": "2026-01-15",
      "amount": 5000,
      "remark": "",
      "invoice_no": "RCV-001",
      "invoice_id": "...",
      "create_by": { "username": "...", "name": "..." },
      "modify_by": { "username": "...", "name": "..." },
      "payment_from": {
        "type": "client",
        "details": { "name": "...", "username": "..." }
      },
      "payment_to": {
        "type": "bank",
        "details": {
          "bank_id": "...",
          "holder": "Main Cash",
          "type": "cash",
          "bank": "",
          "account_no": "",
          "remark": ""
        }
      }
    }
  ],
  "stats": {
    "count": 42,
    "amount": 125000.5
  },
  "meta": {
    "page_no": 1,
    "limit": 20,
    "total": 42,
    "count": 20,
    "is_last_page": false
  }
}
```

**Party mapping (receive report)**

- `payment_from` ← `party1` (sender) via `USER_SNIPPED_DATA` or party helpers
- `payment_to` ← `party2` (receiver):
  - `party2_type === "bank"` → `BANK_SNIPPED_DATA`
  - `party2_type === "capital"` → `CAPITAL_SNIPPED_DATA`

**Stats**

- `stats.count` / `stats.amount` are computed for the **date range only** (not filtered by `search`).
- Frontend uses these for summary stat cards.

**Cash bank accounts**

When `payment_to.type` is `bank` and `details.type` is `cash`, `BANK_SNIPPED_DATA` omits `account_no`, `ifsc`, `bank`, `branch` and includes `holder`. Frontend shows holder + `cash` badge.

---

### `GET /transaction/bank/list`

Paginated bank account list with per-type aggregate stats.

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page_no` | number | `1` | |
| `limit` | number | `10` | Clamped 1–100 |
| `search` | string | `""` | Matches account_no, holder, ifsc, bank, branch, remark |

**Response**

```json
{
  "success": true,
  "data": [
    {
      "bank_id": "...",
      "holder": "Main Cash",
      "type": "cash",
      "balance": 15000,
      "...": "..."
    }
  ],
  "stats": {
    "by_type": {
      "savings": { "count": 2, "balance": 50000 },
      "current": { "count": 1, "balance": 120000 },
      "loan": { "count": 0, "balance": 0 },
      "cash": { "count": 1, "balance": 15000 }
    }
  },
  "meta": {
    "page_no": 1,
    "limit": 20,
    "total": 4,
    "count": 4,
    "is_last_page": true
  }
}
```

**`fetchBankListStats`**

- Groups banks by `LOWER(b.type)` for types: `savings`, `current`, `loan`, `cash`.
- `count` — distinct `bank_id` per type (respects search filter).
- `balance` — sum of transaction effects per bank, aggregated by type.
- Balance logic unions `party1_type = 'bank'` and `party2_type = 'bank'` transaction rows.

Helper: `emptyBankTypeStats()` ensures all four keys exist even when zero.

---

## Expense router (`routes/expense.js`)

Mounted at: `/expense`

Discount entries are stored in `discount_entries`, linked to reserved `expense_entries` (`is_reserved = 1`, `reserved = 'discount'`) and expense-type invoices.

Constants:

- `ALLOWED_DISCOUNT_PARTY_TYPES`: `client`, `ca`, `staff`, `agent`
- `DISCOUNT_RESERVED_ITEM_NAME`: `"Discount"` (auto-created expense item per branch)

### `POST /expense/discount/create`

**Body**

```json
{
  "party_id": "username-or-id",
  "party_type": "client",
  "amount": 500,
  "remark": "optional",
  "transaction_date": "2026-01-15"
}
```

**Validation**

- `party_id`, `party_type`, `amount` (> 0), `transaction_date` required
- `party_type` must be in `ALLOWED_DISCOUNT_PARTY_TYPES`
- Requires active invoice prefix for type `expense`

**Side effects (transaction)**

1. Creates expense invoice + `transactions` row (`transaction_type = 'expense'`)
2. Inserts `expense_entries` (reserved discount line)
3. Inserts `discount_entries` with generated `discount_id`, `invoice_no`

**Response**

```json
{
  "success": true,
  "message": "Discount entry created successfully",
  "data": { "...mapped discount row..." }
}
```

### `PUT /expense/discount/edit`

**Body**

```json
{
  "discount_id": "...",
  "party_id": "...",
  "party_type": "client",
  "amount": 600,
  "remark": "updated",
  "transaction_date": "2026-01-16"
}
```

Updates `discount_entries`, linked `transactions`, and `expense_entries` in a DB transaction.

### `GET /expense/discount/details`

**Query:** `discount_id` (required)

Returns single mapped row or `404`.

### `GET /expense/discount/list`

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page_no` | number | `1` | |
| `limit` | number | `10` | Clamped 1–100 |
| `from_date` | string | `1970-01-01` | Filters `discount_date` |
| `to_date` | string | `2099-12-31` | |
| `search` | string | — | remark, expense remark, invoice_no, amount, party_id |

**Response**

```json
{
  "success": true,
  "data": [
    {
      "discount_id": "...",
      "discount_date": "2026-01-15",
      "transaction_date": "2026-01-15",
      "amount": 500,
      "remark": "...",
      "invoice_no": "EXP-001",
      "party_type": "client",
      "party_id": "...",
      "discount_party": {
        "type": "client",
        "details": { "name": "...", "username": "...", "mobile": "...", "email": "..." }
      },
      "create_by": { "...": "..." },
      "modify_by": { "...": "..." },
      "create_date": "...",
      "modify_date": "..."
    }
  ],
  "stats": {
    "count": 10,
    "amount": 5000
  },
  "pagination": {
    "page_no": 1,
    "limit": 20,
    "total": 10,
    "is_last_page": true
  }
}
```

**Notes**

- List joins `discount_entries` → `expense_entries` (reserved discount) → `transactions`.
- `stats` uses date range only (not search), same pattern as receive report.
- Pagination key is `pagination` (not `meta`) — frontend `discount.js` reads `pagination.total`.

**`mapDiscountListRow`**

Resolves `discount_party.details` via `USER_SNIPPED_DATA` (and bank/capital helpers when applicable). Includes care-of / guardian fields for display.

---

## Related endpoints (not changed in this pass)

| Endpoint | Purpose |
|----------|---------|
| `GET /transaction/bank/details` | Single bank by `bank_id` |
| `POST /transaction/payment/discount` | Legacy/alternate discount path in transactions router |
| Capital routes in `routes/capital.js` | Capital register CRUD/list |

---

## Error shape

All endpoints return consistent errors:

```json
{
  "success": false,
  "message": "Human-readable message",
  "error": "optional stack/detail"
}
```

HTTP status: `400` validation, `404` not found, `500` server error.
