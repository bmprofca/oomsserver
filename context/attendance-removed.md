# Attendance — removed (rebuild from scratch)

> Attendance UI, punch APIs, and the old `attandance.js` router were removed (2026-07-30) so the feature could be rebuilt cleanly.

**Phase-1 rebuild is live** — see [`attendance.md`](./attendance.md) and [`CLIENT/context/attendance.md`](../../CLIENT/context/attendance.md). Keep this file for historical removal notes only.

## What was removed

- `SERVER/routes/attandance.js` (attendance endpoints)
- CLIENT: `staff-attendance.jsx`, `AttendanceTab.js`, `EntryReportTab.js`, `AttendancePunchSuccessModal.js`
- Header punch-in/out, sidebar Attendance link, `/staff/attendance` route
- Subscription feature `attendance-management`
- Permission option renamed: `staff_attendance_view_manage` → `staff_view_manage` (legacy id still accepted in permission helper)
- **DB tables dropped:** `attendance`, `attendance_break`  
  Script: `node database/scripts/drop-attendance-tables.js` (from `SERVER/`)

## What was kept (salary)

Salary/payslip/weekly-off/adjustments live in:

- `SERVER/routes/salary.js` mounted at **`/api/v1/salary/*`**
- CLIENT tabs still call `/salary/...` (`SalaryTab`, `StaffPayslip`, `BonusFineTab`)

Salary calculation tolerates missing attendance tables (empty punch history).

## Rebuild status (phase 1 done)

1. ~~New route file + mount `/attendance`~~ → `SERVER/routes/attendance.js`
2. ~~Tables~~ → `attendance` + `` `break` `` (`username` on break)
3. Subscription feature + permissions — still out of scope
4. Manage page / profile tab — still out of scope; header opens **AttendanceModal**
5. Salary calc wiring — still pending
6. Re-add tables to `database-context.json` when schema is final
