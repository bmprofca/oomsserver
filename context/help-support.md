# Help & Support — Server context

> **Purpose:** Tag when changing platform help contacts, FAQs, or `/help-support` APIs. Pair with [`CLIENT/context/help-support.md`](../../CLIENT/context/help-support.md) and [`ADMIN/context/help-support.md`](../../ADMIN/context/help-support.md).

---

## Mental model

```
help_support_platform_config  (single contact/intro row)
help_support_faqs             (many Q&A rows)
        ↓
CLIENT GET /help-support
ADMIN  GET/PUT /help-support/config
ADMIN  CRUD  /help-support/faqs
```

| File | Role |
|------|------|
| `helpers/helpSupportConfig.js` | Contact table ensure + upsert + serialize (`intro_text` is **TEXT**) |
| `helpers/helpSupportFaqs.js` | FAQ table, seed defaults if empty, CRUD |
| `routes/helpSupport.js` | CLIENT `GET /` |
| `routes_admin/helpSupport.js` | Admin config + FAQ routes |
| `database/migrations/20260922_help_support_platform_config.sql` | Contact table |
| `database/migrations/20260922_help_support_faqs.sql` | FAQ table + intro TEXT alter |
| `scripts/run_help_support_faqs_migration.js` | Ensure + seed |

Mounted: CLIENT `router.use("/help-support", …)` · ADMIN `router.use("/help-support", …)`.

---

## CLIENT `GET /help-support`

- Auth: `auth`.
- Returns serialized config + **`faqs`** (active only).
- If config `status === inactive` → strip contact fields / `configured: false`; FAQs still returned.

---

## ADMIN

| Method | Path | Purpose |
|--------|------|---------|
| GET/PUT | `/help-support/config` | Page title, **intro_text**, email/phone/WhatsApp/hours/address/website, status |
| GET | `/help-support/faqs` | All FAQs (any status) |
| POST | `/help-support/faqs` | Create |
| PUT | `/help-support/faqs/:faqId` | Update |
| DELETE | `/help-support/faqs/:faqId` | Delete |

---

## Tables

**`help_support_platform_config`:** one logical row (latest by `id`). Fields include `page_title`, `intro_text`, contact fields, `status`.

**`help_support_faqs`:** `faq_id`, `question`, `answer`, `sort_order`, `status` (`active`/`inactive`).

Empty FAQ table → seed 5 default product FAQs (`seedDefaultFaqsIfEmpty`).

---

## Do not

- Store help contacts only in env/frontend constants
- Truncate intro to VARCHAR(500) — use TEXT
