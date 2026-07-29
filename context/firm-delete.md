# Firm delete dependency checks

> Tag when changing firm soft-delete behavior.

## Endpoints

| Route | File |
|-------|------|
| `DELETE /client/details/firms/delete/:firm_id` | `routes/client.js` |
| `DELETE /agent/client/firms/:firm_id` | `routes_agent/client.js` |

Both call `GET_FIRM_DELETE_BLOCKERS` + `FORMAT_FIRM_DELETE_BLOCKERS_MESSAGE` from `helpers/function.js` **before** soft-deleting the firm.

## Behavior

- If any linked records exist → **HTTP 409** with a human-readable `message` and `data.blockers: [{ key, label, count }]`.
- Soft-delete proceeds only when the blockers list is empty.

## Checked links

| Key | Table | Filter |
|-----|-------|--------|
| `tasks` | `tasks` | `firm_id` + `branch_id` (any status) |
| `sales` | `sale_entries` | `firm_id` + `branch_id` |
| `documents` | `documents` | `is_deleted = 0` |
| `compliance_firms` | `compliance_firms` | `is_deleted = 0` |
| `compliance_assignments` | `compliance_assignments` | `status = 'active'` |
| `quotations` | `quotations` | `firm_id` + `branch_id` |
| `service_requests` | `service_requests` | `firm_id` + `branch_id` |
| `password_group_firms` | `password_group_firms` | `is_deleted = 0` |
| `file_index` | `file_index` | `is_deleted = 0` |
| `group_firms` | `group_firms` | `is_deleted = 0` |
| `notes` | `notes` | `is_deleted = 0` |

Missing tables (`ER_NO_SUCH_TABLE`) are skipped so older DBs do not hard-fail delete.

## Not checked

Purchases, journals, receipts/payments, and capitals have **no** `firm_id` column in the live schema.
