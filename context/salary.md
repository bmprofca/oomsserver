# Staff salary (server)

## Table

| Table | Role |
|-------|------|
| `staff_salaries` | One row per staff salary period: type (`fixed` \| `flexible`), `amount`, `monthly_working_minutes`, `expected_minutes`, `effective_from` / `effective_to`, `is_active`, attendance settings |
| `payslip_entries` | Posted monthly payslips keyed by `username` + `year` + `month` (not `salary_id`); links invoice + transaction |

Legacy `salaries` + `staff_salary_assignments` were merged into `staff_salaries` (`20260802_merge_staff_salaries.sql`). Unused allowance/penalty columns and decimal-hour fields were removed (`20260802_slim_staff_salaries.sql`). Payslips: `20260802_payslip_entries.sql`.

### Kept columns (`staff_salaries`)

Identity (`salary_id`, `map_id`, `username`, `branch_id`), `salary_type`, `amount`, `monthly_working_minutes`, effective/active, shift times (`working_hours_start` / `working_hours_end`), `expected_minutes`, `grace_period_minutes`, `overtime_enabled`, `fine_enabled`, `allowed_break_minutes`, audit/soft-delete.

## Rules

- **Fixed**: standard monthly amount. Uses `expected_minutes`, grace minutes, overtime, fine toggles, weekly offs, and break minutes.
- **Flexible**: requires `monthly_working_minutes`. Full pay when monthly minutes are fulfilled. **No** overtime, fine, expected daily minutes, grace, or weekly offs.
- Duration fields: prefer `*_minutes` in request body; legacy `*_hours` are still accepted and converted on write.
- Multiple rows per staff allowed; **only one** `is_active = '1'` per staff + branch.
- All fields editable; soft-delete via `is_deleted`.
- **Create** (`/admin/set-salary`): `effective_from` must be today or a future date.
- **Update** (`/admin/update-salary`): may edit amount/settings and keep or change `effective_from` even if it is in the past (regenerate payslips afterward if needed). Expired rows (`effective_to` before today) stay non-editable.

## Payslip / monthly ledger post

Stored payslip records key by **`username` + `month` + `year`** (and branch), **not** `salary_id`.

On generate:

1. Amount = attendance net (leave days = full calendar-day wage from salary for that date) + month bonuses − month fines.
2. Leave days with missing/zero stored `net_day_amount` are recomputed and **persisted** on generate so attendance matches the ledger.
3. Resolve reserved expense item `expense_items.name = 'Salary'` AND `is_reserved = '1'` (same pattern as Discount).
4. Create expense invoice + `transactions` with `party1_type='staff'`, `party1_id=username`, positive amount (credits staff ledger).
5. `expense_entries` + `expense_entries_items` (Salary item) + `payslip_entries`.
6. `transaction_date` / `payslip_date` = last day of the month, or **today** if that date is still in the future.
7. **Regenerate** allowed: same `username` + month + year updates linked invoice / transaction / expense / `payslip_entries` amounts (does not create a second row).

Expense list excludes payslip-linked rows (`NOT EXISTS payslip_entries`), same as discount.

## APIs (`/api/v1/salary`, feature `salary-management`)

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/admin/set-salary` | Create assignment |
| `POST` | `/admin/update-salary` | Edit (`assignment_id` or `salary_id`) |
| `POST` | `/admin/delete-salary` | Soft-delete |
| `GET` | `/admin/salary-history?username=` | List |
| `GET` | `/payslip/list?username=` | All posted payslips (`year DESC, month DESC`); optional `year=`; includes `payable_amount`, `needs_regenerate` |
| `POST` | `/payslip/preview` | Month wage preview (attendance + bonus − fine) |
| `POST` | `/payslip/generate` | Post salary to ledger + registry |
| `GET` | `/payslip/download?payslip_id=` | PDF payslip (PDFKit via `helpers/payslipPdf.js`) |
| `GET` | `/bonus-fine/list?username=` | Month-scoped bonus/fine entries (`type` optional) |
| `POST` | `/bonus-fine/create` | `{ username, type, month, year, amount, remark }` |
| `POST` | `/bonus-fine/update` | `{ entry_id, … }` |
| `POST` | `/bonus-fine/delete` | Soft-delete `{ entry_id }` |

Table `staff_bonus_fine`: migration `20260803_staff_bonus_fine.sql`. Payslip payable = attendance net + bonuses − fines for that month.
| `POST` | `/admin/set-weekly-off` | `{ days: [...] }` |
| `GET` | `/admin/get-weekly-off?username=` | Returns `days` array |

API still returns `assignment_id` (= `salary_id`) for client compatibility.
