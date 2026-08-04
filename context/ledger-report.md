# Ledger statement PDF + share — Server context

> **Purpose:** Tag when changing client ledger PDF generation, download/share endpoints, or “document sharing” WhatsApp header media override. Pair with [`CLIENT/context/ledger-tab.md`](../../CLIENT/context/ledger-tab.md) and [`wp_system.md`](./wp_system.md).

---

## Mental model

```
collectLedgerStatement (branch + party + rows)
        ↓
generateLedgerPdfBuffer (portrait A4)
        ↓
GET /transaction/download/ledger  →  PDF bytes
   or
POST /transaction/ledger/share    →  upload PDF → WhatsApp / email / SMS
```

**Helper:** `SERVER/helpers/ledgerReport.js`  
**Routes:** `SERVER/routes/transactions.js`

---

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/transaction/download/ledger` | branch | Query: `party_type`, `party_id`, `from_date`, `to_date`, `format` (`pdf` / excel / csv) |
| POST | `/transaction/ledger/share` | branch | Body: party + date range + `channels[]`; currently **client** party only |

Share flow: build PDF → upload to `upload.onesaas.in` → send via notification type **`document sharing`**.

---

## `collectLedgerStatement`

Inject `getOppositePartySnippet` from the transactions route (avoids circular imports).

Returns:

- `partyDetails` — for clients: `name`, `email`, `mobile`, `pan` (from `profile.pan_number`), `id` (username)
- `branchDetails` — from `branch_list`: name, legal_name, address lines, city/state/pincode, mobile_1/2, email_1/2, gst, pan
- `openingDebit` / `openingCredit` / `openingBalance`
- `statementData[]` — date, particular (+ remark appended when present), type, invoice_no, debit, credit, balance
- `summary` — totalDebit, totalCredit, closingBalance

Debit/credit rules match `/transaction/list` party1/party2 logic.

---

## `generateLedgerPdfBuffer` (layout rules)

Portrait A4, PDFKit, `bufferPages: true`.

| Rule | Detail |
|------|--------|
| Title | **Ledger Statement** (centered under header) |
| Header | **Left:** branch name / address / contacts / GST·PAN · **Right:** client name / mobile / email / PAN |
| Currency | Numbers only — **no** `₹` or `Rs.` prefix; use thousands commas + 2 decimals |
| Dates | **DD-MM-YY** in table and period line |
| Particulars | Full wrap, **no** ellipsis; row height from `heightOfString` of all cells |
| Table | Outer + column borders; **striped** rows; cell X padding |
| Colors | Colored text (debit blue, credit orange, negative balance **red** with minus e.g. `-900.00`); header underline teal |
| Negative balance | Signed (`formatCurrency(n, { signed: true })`) in red for opening / running / total |
| Footer | Reserved bottom margin (~48pt) so “Generated … Page x of y” does **not** create an extra blank page |
| Page break | Close table outer border on previous page before `addPage`; redraw header on next page |

**Do not**

- Use landscape layout
- Slice particulars with `...`
- Write footer without reserving bottom safe zone (extra page bug)
- Rely on Unicode rupee glyph (broken in Helvetica)

---

## Document sharing / WhatsApp

- Template name: **`document sharing`** (`SERVER/utils/WhatsAppTemplates.js`; aliases in `routes/utils.js`)
- `applyHeaderMediaOverride` in `helpers/whatsappNotification.js` — send uses the **uploaded ledger PDF URL** as HEADER document, not static mapped media

---

## Call sites (pass `branchDetails`)

```js
generateLedgerPdfBuffer({
  partyDetails,
  branchDetails: ledger.branchDetails,
  fromDate,
  toDate,
  openingDebit,
  openingCredit,
  openingBalance,
  statementData,
  summary,
});
```

Both download and share routes must pass `branchDetails`.
