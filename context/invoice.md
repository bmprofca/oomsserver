# Invoice PDF generation — Server context

> **Purpose:** Tag when changing invoice PDF generate, format mapping, sample PDFs, or ledger `downloadable`. Pair with [`CLIENT/context/invoice.md`](../../CLIENT/context/invoice.md) and [`CLIENT/context/ledger-tab.md`](../../CLIENT/context/ledger-tab.md).

---

## Canonical generate endpoint (main CLIENT app)

```
POST /invoice/generate
```

- Auth: `auth` + `validateBranch`
- Handler: `routes/invoice.js` → `services/invoiceGenerateService.js`
- **Do not** re-add `POST /invoice/generate-invoice` (removed; clients must use `/generate` only)

### Body

| Field | Required | Notes |
|-------|----------|--------|
| `invoice_id` | yes | Source document / transaction invoice id |
| `type` | yes | One of allowed generate types (below) |
| `response` | no | `"pdf"` → binary PDF stream; otherwise JSON with saved URL metadata |

### Allowed generate / format types

Only these (see `helpers/invoiceFormatMapping.js` → `INVOICE_GENERATE_TYPES` and `services/invoiceGenerateService.js` → `ALLOWED_GENERATE_TYPES`):

- `sale`
- `purchase`
- `payment`
- `receive` (DB alias `payment receive` normalizes to `receive`)
- `journal`
- `expense`

**Not supported for PDF generate / format cards:** `contra`, `opening balance`, quotation-as-invoice-type, loan types, etc. Prefix numbering may still use a broader type list.

Use `isSupportedGenerateType(type)` from `invoiceFormatMapping.js` anywhere UI/API needs the same gate.

---

## PDF engine

- PDFs are built with **PDFKit** via `helpers/pdfGenerator.js` → `buildUnifiedInvoicePdfBuffer`.
- **No Puppeteer / Chrome** — do not reintroduce browser-based HTML→PDF for this path.
- Related callers: `invoiceGenerateService`, `walletInvoiceService`, quotation PDF, format sample PDFs (`invoiceFormatSamplePdfs.js`).
- Contra format templates under `templates/format/contra/` were removed; do not restore for generate.

---

## Format mapping

`helpers/invoiceFormatMapping.js`:

- `INVOICE_FORMAT_MAPPING` — type → allowed format keys (classic, modern, …)
- `isValidFormatForType(type, formatId)`
- `isSupportedGenerateType(type)`

`/invoice/formats` and generate reject unsupported types.

---

## Ledger list: `downloadable`

`GET /transaction/list` (`routes/transactions.js`) includes on each row:

```js
downloadable: Boolean(row.invoice_id && isSupportedGenerateType(row.transaction_type))
```

- Opening balance and other non-generate types → `downloadable: false` (even if an `invoice_id` exists for numbering).
- CLIENT ledgers show **Download** in the row action menu only when `downloadable === true`.

---

## Portal aliases (separate from main `/invoice`)

Agent / CA / Client portal routers still expose their own:

- `POST …/transaction/generate-invoice` under `routes_agent` / `routes_ca` / `routes_client`

Those are portal-scoped. The **main branch CLIENT app** should keep calling **`POST /invoice/generate`**.

---

## Share API

```
POST /invoice/share
```

- Auth: `auth` + `validateBranch`
- Generates PDF, uploads, then sends via document-sharing templates (`channels`).
- Body: `invoice_id`, `type` (same generate types), `channels`, optional `mobile` / `email`
- Delivery uses payload `mobile` / `email` when present; otherwise falls back to the resolved party profile.

Recipient resolution (high level):

| `type` | Shareable party |
|--------|-----------------|
| `sale` | `party2_type === client` |
| `purchase` | `party1_type` in `client` / `ca` |
| `receive` / `payment` | `party2_type === client` (fallback also checks client on either party) |

If no client/CA username can be resolved → `400` with a clear message (CLIENT should toast before calling when party is known unsupported).

---

## Sale / purchase edit (registers)

- `PUT /sale/edit` — updates invoice / entries / items; keeps `invoice_no`; **rejects task sales** (`is_task = '1'`).
- `PUT /purchase/edit` — `executeEditPurchase` in `helpers/purchaseCreate.js`.
- Sale list may expose `task_id` (from `tasks.invoice_id` + `sale_items.remark` `task:…` fallback) for CLIENT “Edit (Task)” navigation.

See CLIENT [`finance-registers.md`](../../CLIENT/context/finance-registers.md).

---

## Sale list tax note

On `GET /sale/list`, tax stats / per-row GST must **not** sum `grand_total` as tax. Derive tax from totals (e.g. total − (subtotal − discount) − additional_charge). See `routes/sale.js`.

---

## Key files

| Path | Role |
|------|------|
| `routes/invoice.js` | `/generate`, `/share`, formats, prefixes |
| `services/invoiceGenerateService.js` | Build + optional save PDF |
| `helpers/invoiceFormatMapping.js` | Allowed types + formats |
| `helpers/pdfGenerator.js` | PDFKit buffer |
| `helpers/invoiceDataBuilder.js` | Payload for PDF |
| `routes/transactions.js` | List `downloadable` flag |
| `routes/sale.js` | Sale list + `PUT /sale/edit` |
| `routes/purchase.js` / `helpers/purchaseCreate.js` | Purchase list + edit |
