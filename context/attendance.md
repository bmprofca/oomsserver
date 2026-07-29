# Attendance (phase 1) — punch + break API

> Tag when changing staff punch/break backends, timezone writes, or `breaks[]` payload.  
> Client UI: [`CLIENT/context/attendance.md`](../../CLIENT/context/attendance.md)

---

## Scope (phase 1)

| In | Out |
|----|-----|
| Manual punch in / out | Manage attendance page |
| Break start / end | Staff profile Attendance tab |
| Today’s breaks list on status payload | GPS / IP / face / biometric methods |
| Explicit `Asia/Kolkata` timestamps from Node | Admin approve / verify |
| | Subscription feature gate |
| | Salary calc wiring |

Historical removal notes: [`attendance-removed.md`](./attendance-removed.md) (salary stayed on `/salary`).

---

## Tables

### `attendance`

One row per `(branch_id, username, date)`.

| Column | Notes |
|--------|--------|
| `attendance_id` | Public id |
| `branch_id` / `username` / `date` | Day key (date from `ATTENDANCE_TIMEZONE`) |
| `in_time` / `out_time` | Written by API as `YYYY-MM-DD HH:mm:ss` — **not** MySQL `NOW()` |
| `status` | Punch in sets `present` |
| `in_method` / `out_method` | Default `manual` |
| `is_approved` | Stays `0` in phase 1 |
| `create_by` / `modify_by` | Audit = acting username |

### `` `break` ``

Multiple rows per staff/day. Link via **`branch_id` + `username` + `date`** (not `create_by`). Always backtick table name.

| Column | Notes |
|--------|--------|
| `break_id` | Public id |
| `username` | Staff who took the break |
| `start_time` / `end_time` | Open break = `end_time IS NULL`. Same Node timezone write as punches |
| `create_by` / `modify_by` | Audit only |

---

## Timezone

- Env: `ATTENDANCE_TIMEZONE` (default **`Asia/Kolkata`**)
- Helpers in [`SERVER/routes/attendance.js`](../routes/attendance.js):
  - `getAttendanceDateString()` → calendar `date` (`en-CA`)
  - `getAttendanceNowString()` → MySQL DATETIME for `in_time` / `out_time` / break times / `modify_date`
- Do **not** use SQL `NOW()` for punch or break times (DB server clock often differs from IST).

---

## Rules

1. Punch in → INSERT (reject if today’s row already exists — even if already punched out).
2. Punch out → UPDATE `out_time` (reject if not punched in, already out, or open break).
3. Break start → only while punched in (`out_time IS NULL`) and no open break.
4. Break end → close open break; required before punch out.

States: `not_punched` | `punched_in` | `on_break` | `punched_out`.

---

## API

Mount: [`SERVER/routes/index.js`](../routes/index.js) → `/api/v1/attendance/*`  
File: [`SERVER/routes/attendance.js`](../routes/attendance.js)  
Auth: `auth` + `validateBranch` (no subscription gate).  
Username: request header `username`.

| Method | Path | Action |
|--------|------|--------|
| GET | `/today-status` | Today state + attendance + `open_break` + `breaks[]` |
| POST | `/punch-in` | Body optional `{ method }` (default `manual`) |
| POST | `/punch-out` | Body optional `{ method }` |
| POST | `/break/start` | Start break |
| POST | `/break/end` | End open break |

### Status / action payload (`data`)

```json
{
  "date": "2026-07-30",
  "timezone": "Asia/Kolkata",
  "state": "punched_in",
  "attendance": { "attendance_id": "…", "in_time": "…", "out_time": null, "…" : "…" },
  "open_break": null,
  "breaks": [
    { "break_id": "…", "username": "…", "start_time": "…", "end_time": "…", "…" : "…" }
  ]
}
```

- `breaks`: all rows for that staff/branch/date, ordered by `start_time ASC`
- `open_break`: first/open row with `end_time IS NULL` (or `null`)
- Mutations return the same shape after commit
