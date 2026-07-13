# V3 → V5 Branch Migration Guide

Migrate data from the old OOMS v3 database (`u278432002_ooms_v3`) into an existing v5 branch in `u278432002_ooms_v5`.

**Reference migration:** `APP2025` / `BRN2025` → branch `123456` (Bmtax-OPC).

---

## Overview

| Item | Value |
|------|--------|
| Old filter | `app_id = APP2025` AND `branch_id = BRN2025` |
| Target branch | `123456` (configurable) |
| Staging | Same DB as v5, tables prefixed `v3staging_` |
| Script root | `SERVER/database/scripts/migrate-v3/` |
| Entry point | `SERVER/database/scripts/migrate-v3-branch.js` |

The migration is **ETL-based**: import v3 SQL dump into prefixed staging tables, then run phased inserts into the live v5 schema.

```
v3 SQL dump  →  v3staging_* tables  →  Phase A–E  →  branch 123456 (v5)
```

---

## Prerequisites

1. **Target branch exists** in `branch_list` with the desired `branch_id` (e.g. `123456`).
2. **`.env`** in `SERVER/` has valid `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
3. **v3 SQL dump** available (default path in config or pass `--dump`).
4. Branch should have **little or no business data** before first migration (or use repair/reset scripts below).

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MIGRATE_OLD_APP_ID` | `APP2025` | Source app_id in staging |
| `MIGRATE_OLD_BRANCH_ID` | `BRN2025` | Source branch_id in staging |
| `MIGRATE_NEW_BRANCH_ID` | `123456` | Target v5 branch_id |
| `STAGING_TABLE_PREFIX` | `v3staging_` | Prefix for imported v3 tables |
| `STAGING_DB_NAME` | `DB_NAME` | Database hosting staging tables |
| `MIGRATE_SQL_DUMP` | path to v3 `.sql` file | Source dump for import |
| `MIGRATE_BATCH_SIZE` | `500` | Insert batch size |

---

## NPM commands

Run from `SERVER/`:

| Command | Description |
|---------|-------------|
| `npm run migrate:v3:import` | Import v3 SQL dump into `v3staging_*` tables |
| `npm run migrate:v3` | Run all phases (A–E) + verification |
| `npm run migrate:v3:dry` | Dry run (no writes) |
| `npm run migrate:v3:verify` | Verification only |
| `npm run migrate:v3:snapshot` | Backup target branch data before changes |
| `npm run migrate:v3:finance-reset` | Delete finance tables for target branch only |
| `npm run migrate:v3:fix-party-types` | Repair CA/agent/client party_type on transactions |
| `npm run migrate:v3:fix-opening-balances` | Normalize opening balance party placement |
| `npm run migrate:v3:diagnose-debtors` | Compare debtor counts across methods |
| `npm run migrate:v3:dedupe-invoices` | Remove duplicate branch invoices |
| `npm run migrate:v3:staff-reset` | Delete v5 staff rows for target branch (dry-run unless `--force`) |
| `npm run migrate:v3:staff-import` | Re-import v3 employees as users + profile + branch_mapping |
| `npm run migrate:v3:staff` | Reset (`--force`) then import staff in one step |
| `npm run migrate:v3:staff-verify` | Verify all v3 employees exist in v5 staff tables |

### CLI flags (`migrate-v3-branch.js`)

```bash
node database/scripts/migrate-v3-branch.js --dry-run
node database/scripts/migrate-v3-branch.js --verify
node database/scripts/migrate-v3-branch.js --module=d          # finance only
node database/scripts/migrate-v3-branch.js --module=a,b,c

node database/scripts/import-v3-staging.js --dump /path/to/dump.sql --force
```

Logs are written to `SERVER/database/scripts/reports/migrate-v3-*.log`.

---

## Standard runbook (new branch)

```bash
cd SERVER

# 1. Optional: snapshot existing branch data
npm run migrate:v3:snapshot

# 2. Import v3 dump into staging (once per dump)
npm run migrate:v3:import
# or: npm run migrate:v3:import -- --dump "C:\path\to\u278432002_ooms_v3.sql" --force

# 3. Dry run (recommended first time)
npm run migrate:v3:dry

# 4. Full migration
npm run migrate:v3

# 5. Post-migration repairs (if migrating into branch that already ran an older script version)
npm run migrate:v3:fix-party-types
npm run migrate:v3:fix-opening-balances

# 6. Verify
npm run migrate:v3:verify
```

Restart the API server after migration and repair scripts so `GET_BALANCE` and dashboard SQL pick up current logic.

---

## Staff re-migration (v3 employees only)

Use when staff on the target branch were not migrated correctly but finance/tasks/clients should stay untouched. Preserves **v3 usernames** so `transactions`, `task_staffs`, and related tables keep working.

**Scope:** `v3staging_users` where `user_type = employee` → v5 `users`, `profile` (`user_type = staff`, insert if missing), and `branch_mapping` (`type = staff`) on branch `MIGRATE_NEW_BRANCH_ID` (default `123456`).

**Attendance is not modified** by staff reset or import.

### Typical path after manual reset (admin-only `branch_mapping`)

If you have already cleared `users` and `branch_mapping` staff rows and kept only the branch admin:

```bash
cd SERVER

# 1. Ensure staging tables are loaded
npm run migrate:v3:import

# 2. Preview import (no writes)
npm run migrate:v3:staff-import -- --dry-run

# 3. Apply import
npm run migrate:v3:staff-import

# 4. Verify
npm run migrate:v3:staff-verify
```

### Full reset + re-import (optional)

```bash
npm run migrate:v3:staff-reset              # preview deletes
npm run migrate:v3:staff-reset -- --force   # delete staff users/profile/mapping only
npm run migrate:v3:staff-import
# or: npm run migrate:v3:staff
npm run migrate:v3:staff-verify
```

**Reset deletes (per employee username):** `branch_mapping` (staff only), `tokens`, `profile`, `users`. Does **not** delete `attendance`. Usernames that also exist in `clients` are skipped.

**Import order (matches v5 onboarding):** `users` (if missing) → `profile` (if missing) → `branch_mapping` (`type = staff`, if missing). No login tokens are created; staff can use OTP login if mobile is in `profile`.

---

## Migration phases

| Phase | File | Contents |
|-------|------|----------|
| **A** | `phases/phaseA.js` | Branch settings, invoice prefixes, banks, capitals, services, expense items |
| **B** | `phases/phaseB.js` | Users, clients, branch_mapping, profiles, firms, groups |
| **C** | `phases/phaseC.js` | Tasks, task notes, task staff |
| **D** | `phases/phaseD.js` | Finance: invoices, transactions, sale/purchase/expense/journal entries |
| **E** | `phases/phaseE.js` | Attendance, documents, media checklist |

Phase D is invoice-driven: each staging `invoice` row produces one v5 `invoice` + one `transactions` row, plus type-specific entry tables.

---

## Key schema mappings

### Branch filter (staging)

All staging reads filter by:

```sql
app_id = ? AND branch_id = ?   -- most tables
branch_id = ? AND app_id = ?   -- some tables (users, tasks, group_id) use reversed order
```

Helpers: `queryBranchRows()`, `BRANCH_FILTER_PARAMS` in `utils.js`.

### User types (Phase B → v5)

| v3 `users.user_type` | v5 `clients.user_type` | v5 `branch_mapping.type` |
|----------------------|------------------------|----------------------------|
| `user` | `client` | — |
| `ca` | `ca` | — |
| `agent` | `agent` | — |
| `admin` | — | `admin` |
| `employee` | — | `staff` |

### Party type resolution (Phase D)

Old v3 ledger often uses `party_type` / `viewer_type = "user"` for **all** person parties (clients, CAs, agents).

`resolvePartyType()` in `utils.js`:

1. Map old type (`user` → `client`, `ca` → `ca`, etc.).
2. If mapped as `client` but username is **not** a plain client (`user_type = user`), resolve from `loadStagingPartyTypeByUsername()`:
   - `ca` → `ca`, `agent` → `agent`, staff types → `staff`.

**Common bug (fixed):** CAs in ledger as `user` were inserted as `party_type = staff`, so `GET_BALANCE({ party_type: "ca" })` returned 0. Run `migrate:v3:fix-party-types` to correct existing rows using `clients.user_type`.

### Transaction types

| v3 invoice type | v5 `transactions.transaction_type` | v5 `invoice.type` |
|-----------------|-----------------------------------|-------------------|
| `received` | `receive` | `payment receive` |
| `opening balance` | `opening balance` | `opening balance` |
| `asset purchase` | `purchase` | `purchase` |

### Purchase entries (v5 model)

- `party1` = supplier party, `party2` = null.
- Migrated via `resolvePurchaseParty()`.

---

## Opening balance convention (v5)

Amounts are **always positive**. Direction is determined by **which party column** holds the client:

| Type | Party | Meaning |
|------|-------|---------|
| **Debit** (receivable) | `party2_type` / `party2_id` | Client owes branch |
| **Credit** (payable) | `party1_type` / `party1_id` | Branch owes client |

Legacy migration initially stored signed amounts on `party1` only. Run:

```bash
npm run migrate:v3:fix-opening-balances
```

This script reads staging ledger `type` per invoice (`0` = debit, `1` = credit) and sets the correct party column. **Do not** run debit and credit fixes as two separate passes on already-positive credits (that mis-assigns credits to party2).

`SET_OPENING_BALANCE` / `EDIT_OPENING_BALANCE` in `helpers/function.js` and the set route in `routes/transactions.js` follow the same model.

---

## Balance calculation (v5)

Used by `GET_BALANCE`, dashboard debtors/creditors, and `helpers/clientBalanceSql.js`:

```
balance = SUM(amount where party matches on party2) − SUM(amount where party matches on party1)
```

- Positive balance → **debtor** (receivable).
- Negative balance → **creditor** (payable).

Dashboard quick-stats (`/dashboard/quick-stats`):

- `debtors.total_amount` — positive sum of debtor balances.
- `creditors.total_amount` — **already negative** from SQL (`balance < -0.02`); do not negate again in the API response.

Debtors/creditors list pages filter `clients.user_type = 'client'` only.

---

## Post-migration repair scripts

### `fix-party-types.js`

Updates `party1_type` / `party2_type` on:

- `transactions`
- `journal_entries`
- `sale_entries`
- `purchase_entries`
- `expense_entries`

Uses `clients.user_type` as source of truth for `client`, `ca`, `agent`.

### `fix-opening-balances.js`

Re-applies opening balance party placement from staging ledger type for all `transaction_type = 'opening balance'` rows.

### `finance-reset.js`

Deletes finance data for the target branch only (invoices, transactions, sale/purchase/expense/journal entries). Use before re-running Phase D:

```bash
npm run migrate:v3:finance-reset
node database/scripts/migrate-v3-branch.js --module=d
npm run migrate:v3:fix-party-types
npm run migrate:v3:fix-opening-balances
npm run migrate:v3:verify
```

---

## Verification (`verify.js`)

After each run, checks include:

- Staging vs target row counts (clients, firms, tasks, invoices, transactions).
- Purchase entries match staging purchase invoice count.
- All purchase transactions have `party2_id` null.
- Per-client balance: expected (rebuilt from staging) vs `CLIENT_BALANCE_EFFECTS_SQL`.
- CA balance mismatches.
- Debtor count vs staging ledger baseline and dashboard SQL.
- Spot check: Jahed Ali opening balance and balance total.

---

## Important files

| Path | Role |
|------|------|
| `database/scripts/migrate-v3-branch.js` | Main runner |
| `database/scripts/import-v3-staging.js` | SQL dump → `v3staging_*` |
| `database/scripts/migrate-v3/config.js` | IDs, prefixes, paths |
| `database/scripts/migrate-v3/utils.js` | Party resolution, transaction builders, balance helpers |
| `database/scripts/migrate-v3/phases/phaseD.js` | Finance migration |
| `database/scripts/migrate-v3/verify.js` | Verification checklist |
| `helpers/clientBalanceSql.js` | Debtor/creditor list SQL (must match `GET_BALANCE`) |
| `helpers/function.js` | `GET_BALANCE`, `SET_OPENING_BALANCE` |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| CA balance = 0 | Transactions have `party_type = staff` for CA usernames | `npm run migrate:v3:fix-party-types` |
| Wrong debtor count | Party types or opening balance format | Fix scripts + verify |
| Creditor total positive in UI | API negated already-negative SQL sum | Use `total_amount` as returned from SQL (fixed in `report.js`) |
| `No staging tables found` | Import not run | `npm run migrate:v3:import` |
| Duplicate invoices | Re-ran Phase D | `migrate:v3:dedupe-invoices` or finance-reset + Phase D |
| Balance mismatch after OB fix | Ran two-step OB repair incorrectly | Re-run `migrate:v3:fix-opening-balances` (uses staging ledger type) |

---

## Re-migrating another branch

1. Set env vars: `MIGRATE_OLD_APP_ID`, `MIGRATE_OLD_BRANCH_ID`, `MIGRATE_NEW_BRANCH_ID`.
2. Ensure target branch exists in `branch_list`.
3. Import fresh dump if source data changed (`--force`).
4. Run phases; always run fix-party-types and fix-opening-balances after Phase D.
5. Run verify and spot-check CA list, debtor/creditor counts, and sample client balances in UI.

---

## Notes

- Staging lives in the **same database** as v5 (table prefix), because the DB user may not have `CREATE DATABASE` permission.
- `INSERT IGNORE` is used in batch inserts; re-runs may skip duplicates silently — prefer finance-reset for finance re-runs.
- Media files are not migrated automatically; see `migrate-v3/reports/media-copy-checklist.txt`.
- Admin users in ledger may still map to `staff` instead of `admin` in some rows (separate from CA fix).
