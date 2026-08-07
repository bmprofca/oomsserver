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
POST /transaction/ledger/share    →  upload PDF → WhatsApp / email
```

**Helper:** `SERVER/helpers/ledgerReport.js`  
**Routes:** `SERVER/routes/transactions.js`

---

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/transaction/download/ledger` | branch | Query: `party_type`, `party_id`, `from_date`, `to_date`, `format` (`pdf` / excel / csv) |
| POST | `/transaction/ledger/share` | branch | Body: party + date range + `channels[]` (`whatsapp` / `email`) + optional `mobile` / `email`; currently **client** party only. Delivery uses payload contacts (fallback to profile). |

Share flow: build PDF → upload to `upload.onesaas.in` → send via notification type **`document sharing`**. Recipient WhatsApp/email addresses come from the request body when provided (`sendDocumentSharingWhatsapp` accepts `mobile` / `email` overrides).

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

### Sale particulars

Sale transactions use `party1_type = 'sale'` (invoice id), so opposite-party snippets are empty — do **not** leave Particulars blank.

Format for sale rows (matches ledger UI):

1. **Service names** (primary) — all names joined with `, `
2. **Firm name** (secondary, smaller) via `particular_sub` when linked firm exists
3. Remark appended under services when present; else `-` if nothing else

Batch-load firms/services by `invoice_id` inside `collectLedgerStatement` (select includes `invoice_id`).

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
- Appears in OneChatting **and** WhatsApp Web Static Templates map lists (same `TEMPLATELIST`)
- OneChatting: `applyHeaderMediaOverride` — HEADER document link/filename from upload
- WhatsApp Web: `sendWhatsappWebByChannel` overrides `content.url` / `content.filename` from `headerMedia` at send time
- Web mapping UX (`WhatsAppWebTemplates.jsx`): unset **document sharing** defaults to type Document with `{{document_link}}` / `{{document_name}}`

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
