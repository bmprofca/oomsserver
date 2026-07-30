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
| `in_time` / `out_time` | MySQL **TIME** (`HH:mm:ss`) via `getAttendanceNowTimeString` — not DATETIME |
| `status` | enum: `absent`, `present`, `leave`, `half day` (default `absent`; unused `idle` removed) |
| `in_method` / `out_method` | Default `manual` |
| `is_approved` | Manage mark always sets `1`; personal punch stays `0` until approved |
| `create_by` / `modify_by` | Audit = acting username |

### `` `break` ``

Multiple rows per staff/day. Link via **`branch_id` + `username` + `date`** (not `create_by`). Always backtick table name.

| Column | Notes |
|--------|--------|
| `break_id` | Public id |
| `username` | Staff who took the break |
| `start_time` / `end_time` | MySQL **TIME**. Open break = `end_time IS NULL` |
| `create_by` / `modify_by` | Audit only |

---

## Timezone

- Env: `ATTENDANCE_TIMEZONE` (default **`Asia/Kolkata`**)
- Helpers in [`SERVER/routes/attendance.js`](../routes/attendance.js):
  - `getAttendanceDateString()` → calendar `date` (`en-CA`)
  - `getAttendanceNowTimeString()` → MySQL TIME for `in_time` / `out_time` / break times
  - `getAttendanceNowString()` → MySQL DATETIME for audit fields like `modify_date`
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
Auth: `auth` + `validateBranch` + **staff-only** (`branch_mapping.type !== 'admin'`).

Branch **admins/owners** receive `403` — attendance is for staff mappings only.

| Method | Path | Action |
|--------|------|--------|
| GET | `/day-list` | Day-wise staff list (`?date=&search=&page=&limit=`, default limit 100) |
| POST | `/manage/mark` | Mark Absent/Present/Half Day/Leave — always `is_approved=1` + optional TIME in/out for present |
| POST | `/manage/punch-in` | Legacy manage punch in |
| POST | `/manage/punch-out` | Legacy manage punch out |
| POST | `/manage/break/start` | Start break for staff |
| POST | `/manage/break/end` | End open break for staff |
| POST | `/manage/approve` | `{ username, date?, is_approved: 0\|1 }` |
| POST | `/manage/bulk-approve` | `{ usernames: string[], date? }` — approve only rows with punch in + punch out; skip others |
| GET | `/today-status` | Today state + attendance + `open_break` + `breaks[]` (staff punch modal) |
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
  "mark_status": "present" | "absent" | "leave" | "half day" | null,
  "office_marked": false,
  "attendance": { "attendance_id": "…", "in_time": "…", "out_time": null, "status": "…", "is_approved": "0|1", "…" : "…" },
  "open_break": null,
  "breaks": [
    { "break_id": "…", "username": "…", "start_time": "…", "end_time": "…", "…" : "…" }
  ]
}
```

`state` may also be `absent` | `leave` | `half_day` when office-marked via manage mark. `office_marked: true` means punch/break are not available for that day.

### Day list payload (`GET /day-list`)

Staff source: `branch_mapping` where `type='staff'`, `is_deleted='0'`, `status='1'`, `is_accepted='1'`, joined `profile` + active `users`.

- No attendance row for `date` → `state: "not_marked"` (counts in `summary.absent`; treated as absent)
- Explicit `status = 'absent'` → `state: "absent"`
- Else state from punch/break / leave / half day: `punched_in` | `on_break` | `punched_out` | `present` | `leave` | `half_day`
- Includes `summary` (full filtered set), `is_approved`, `breaks[]`, `pagination` `{ page, limit, total, totalPages, is_last_page }`
- Default `limit=100` (max 100)
- Staff payload includes `mobile` + `country_code` for local display and raw `image` for client-side media-proxy resolution

### Manage mark (`POST /manage/mark`)

Body: `{ username, date?, status: 'absent'|'present'|'leave'|'half day', in_time?, out_time? }`

- Upserts attendance for that staff/day
- Always sets `is_approved = 1` and `approved_by`
- `present` requires both `in_time` and `out_time` (TIME only)
- Other statuses clear `in_time` / `out_time`

### Bulk approve (`POST /manage/bulk-approve`)

Body: `{ usernames: string[], date?: "YYYY-MM-DD" }`

- Sets `is_approved = 1` (+ `approved_by`) only when the attendance row has **both** `in_time` and `out_time` and no open break
- Skips missing staff, incomplete punches, open breaks
- Response: `{ message, data: { date, done, not_done, done_usernames, skipped_usernames } }`
- Success message includes done / not_done counts

### Manage APIs (`/attendance/manage/*`)

Auth: `auth` + `validateBranch` (not personal staff-only). Target must be active staff on the branch.

Auth for `/day-list`: `auth` + `validateBranch` only (admins can manage the list). Personal punch routes still use staff-only middleware.
