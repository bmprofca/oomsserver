# Branch-level GST — Server context

> **Purpose of this file:** Tag this doc in any future chat when adding or changing billing, tasks, sales, invoices, quotations, services, compliance, or tax-related APIs. An agent reading only this file should understand the full GST model and implement correctly without re-deriving the design.

---

## Mental model (read this first)

```
Branch settings  +  Document date  +  Env TAX_RATE  →  tax_rate / tax_value / total
     │                    │                  │
     │                    │                  └─ never from client, never from old DB rate columns
     │                    └─ sale_date / task create_date / today (see table below)
     └─ branch_list.gst_applicable + gst_applicable_after
```

**One sentence:** GST is a **branch policy**, evaluated at **document time**, with a **fixed env rate**. Rates are **computed on the fly**, not stored as editable columns on tasks/invoices/services.

**Why:** Previously every table stored its own `tax_rate` / `gst_rate`. That is gone. Existing money was already at **0% tax** — do **not** backfill historical rows.

---

## When GST applies

All three must be true:

1. `branch_list.gst_applicable = '1'` (string enum `'0'` | `'1'`)
2. Document `asOfDate` is present and parseable as `YYYY-MM-DD`
3. `asOfDate >= branch_list.gst_applicable_after` (date-only, **inclusive**)

If any check fails → `tax_rate = 0`, `tax_value = 0`, `total = fees`.

**Formula (when applicable):**

```
tax_rate  = Number(process.env.TAX_RATE)   // e.g. 18
tax_value = round2(fees * tax_rate / 100)
total     = round2(fees + tax_value)
```

Env key: `TAX_RATE` in `SERVER/.env` (percent number, not `0.18`).

---

## Source of truth vs forbidden sources

| Allowed | Forbidden |
|---------|-----------|
| `branch_list.gst_applicable` | Request body `tax_rate` / `gst_rate` / `tax_perc` |
| `branch_list.gst_applicable_after` | Reading dropped DB columns |
| `process.env.TAX_RATE` | Hardcoding `18` / `0.18` in branch-ops routes (use helper) |
| `helpers/gst.js` | Per-service stored GST rate |

**Exception:** SaaS product billing in `routes/subscription.js` is **out of scope** (plan checkout GST, not branch operations).

**Not tax rate:** `branch_list.gst`, `firms.gst_no`, `is_gst_verified` = GSTIN / identity only.

---

## Database

### Keep on `branch_list`

| Column | Type / values | Role |
|--------|---------------|------|
| `gst` | varchar | Branch GSTIN |
| `is_gst_verified` | enum `'0'`\|`'1'` | GSTIN verified flag |
| `gst_applicable` | enum `'0'`\|`'1'`, default `'0'` | Master switch |
| `gst_applicable_after` | date | First day GST may apply |

### Dropped forever (do not re-add)

| Table | Columns removed |
|-------|-----------------|
| `tasks` | `tax_rate`, `tax_value` |
| `invoice` | `tax_rate`, `tax_value` |
| `sale_items` | `tax_perc`, `tax_value` |
| `quotation_items` | `tax_rate`, `tax_value` |
| `compliance_firms` | `tax_rate`, `tax_value` |
| `service_requests` | `tax_rate`, `tax_value` |
| `branch_services` | `gst_rate`, `gst_value` |

What remains for money: `fees`, `subtotal`, `total`, `grand_total`, discounts, etc.

Migration (idempotent):

```bash
# from SERVER/
node database/scripts/drop-tax-rate-columns.js
```

SQL note: `database/migrations/20260717_drop_tax_rate_columns.sql`

---

## Implementation helper (always use this)

File: [`SERVER/helpers/gst.js`](../helpers/gst.js)

```js
import {
  getTaxRateFromEnv,
  toDateOnly,
  fetchBranchGstSettings,
  isGstApplicable,
  resolveGst,
  resolveBranchGst,
  resolveGstOnTaxable,
} from "../helpers/gst.js";
```

| Function | Use when |
|----------|----------|
| `fetchBranchGstSettings(db, branch_id)` | Once per request (reuse settings) |
| `resolveGst({ fees, asOfDate, settings })` | You already have settings |
| `resolveBranchGst(db, branch_id, { fees, asOfDate })` | One-shot fetch + resolve |
| `resolveGstOnTaxable({ taxableAmount, asOfDate, settings })` | Tax on discounted subtotal (sales) |
| `isGstApplicable(asOfDate, settings)` | Gate “show GST section?” |
| `toDateOnly(value)` | Normalize Date / string → `YYYY-MM-DD` |

Return shape of `resolveGst`:

```js
{ applicable, tax_rate, tax_value, total, fees }
```

---

## Which date (`asOfDate`) to use

| Domain | `asOfDate` |
|--------|------------|
| Task **create** | Today (`toDateOnly(new Date())`) |
| Task **detail / list** charges | `tasks.create_date` |
| Task **edit** fees recalc | Existing task `create_date` (not edit time) |
| Sale create / list / invoice | `sale_entries.sale_date` or request `transaction_date` |
| Billing generate from task | Bill date (`TODAY_DATE()` / sale date used on write) |
| Quotation create/edit | Today at create/edit |
| Service catalog API (`gst_rate` in response) | Today |
| Compliance firm → spawn task | Today |
| Missing / invalid date | Treat as **not applicable** |

---

## Write path (creates / updates)

1. Accept **fees** (and other business fields). **Ignore** any client tax rate fields.
2. Load branch GST settings.
3. `resolveGst` / `resolveGstOnTaxable` with the correct `asOfDate`.
4. Persist:
   - `fees` (or line fees)
   - `total` / `grand_total` / sale entry `total` = amount **including** tax when GST applies; fees-only when not
5. **Do not** INSERT/UPDATE dropped tax columns.

### Discounted sales pattern

1. Sum line fees → `subtotal`
2. Apply discount → `taxableSubtotal`
3. Tax = `resolveGstOnTaxable({ taxableAmount: taxableSubtotal, asOfDate: sale_date, settings })`
4. `grand_total` = taxable + tax + additional − round-off rules (existing `normalizeDiscountAndTotals` style)

---

## Read path (API responses)

Clients still expect fields named `tax_rate`, `tax_value`, `tax_perc`, `gst_rate`, `gst_value` in many places.

**Rule:** compute and attach them; if GST not applicable, return **`0`** (keep response shape stable — prefer zeros over omitting keys).

Example task charges:

```js
const settings = await fetchBranchGstSettings(pool, branch_id);
const gst = resolveGst({
  fees: Number(row.fees) || 0,
  asOfDate: row.create_date,
  settings,
});
charges: {
  fees: gst.fees,
  tax_rate: gst.tax_rate,
  tax_value: gst.tax_value,
  total: gst.total,
}
```

Invoice / sale detail: use **sale_date**; if applicable, expose rate + computed tax on lines/header; if not, zeros.

---

## Checklist for new server work

When adding a feature that involves money + tax:

- [ ] Import `helpers/gst.js` — do not invent a local rate
- [ ] Choose correct `asOfDate` from the table above
- [ ] Ignore client-submitted rates
- [ ] No SQL against dropped columns
- [ ] Response tax fields computed (or zero)
- [ ] New stored totals include tax only when `applicable === true`
- [ ] Do not rewrite historical totals “to fix GST”

---

## Ops: enable GST for a branch

Prefer **Branch Settings → GST Config** in the app (`PUT /settings/branch/gst-config`).

Also supported via `PUT /branch/:branch_id` with:

```json
{ "gst_applicable": "1", "gst_applicable_after": "2026-07-01" }
```

Or SQL:

```sql
UPDATE branch_list
SET gst_applicable = '1',
    gst_applicable_after = '2026-07-01'  -- first day GST may apply
WHERE branch_id = 'YOUR_BRANCH_ID';
```

Disable:

```sql
UPDATE branch_list
SET gst_applicable = '0'
WHERE branch_id = 'YOUR_BRANCH_ID';
```

`GET /branch/:branch_id` and `GET /settings/branch/details` both return `gst_applicable` / `gst_applicable_after` (settings wraps them under `gst_config`).

---

## Key files (server)

| Path | Role |
|------|------|
| `helpers/gst.js` | **Canonical** GST logic |
| `routes/settings.js` | Branch settings GET + `PUT /branch/gst-config` |
| `routes/branch.js` | Branch GET/PUT includes `gst_applicable` fields |
| `routes/task.js` | Task create/edit/detail/list |
| `routes/billing.js` | Generate billable from tasks |
| `routes/sale.js` | Sale invoices |
| `routes/quotation.js` | Quotations |
| `routes/compliance.js` | Compliance firms + task spawn |
| `routes/service.js` | Branch services CRUD + response `gst_*` |
| `helpers/taskCreateHelper.js` | Quotation / request → task |
| `helpers/function.js` | Opening-balance invoice insert (no tax cols) |
| `helpers/saleStaticEmail.js` | Sale email line enrichment |
| `services/branchSetupService.js` | Seed branch services (no gst cols) |

Client mirror: [`CLIENT/context/gst-change.md`](../../CLIENT/context/gst-change.md)
