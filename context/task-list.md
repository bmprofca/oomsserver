# Task list — Server context

> **Purpose:** Tag when changing task list / staff-tasks / task-detailed payloads used by table UIs (complete date, compliance period). Pair with [`CLIENT/context/task-list-display.md`](../../CLIENT/context/task-list-display.md).

---

## Complete date

### `GET /task/list` — `SERVER/routes/task.js`

- SELECT includes `t.complete_date`.
- Response includes:
  - `dates.complete_date`
  - top-level `complete_date`

Without this, the task list UI cannot show completion under status.

### Other feeds (already expose complete date in many shapes)

| Endpoint area | Notes |
|---------------|--------|
| `report/task-detailed` | `task_details.complete_date` → mapped to `dates.complete_date` on client |
| `report/staff-tasks` | top-level `complete_date` + `dates.complete_date` |

---

## Compliance period

List/report rows should include where available:

- `compliance_year`, `compliance_period`
- service `frequency` (for label building on client)

Client builds the human label via `getTaskCompliancePeriodLabel`.

---

## Do not

- Strip `complete_date` from `/task/list` “for slimming” — UI depends on it for completed rows
- Trust only client-computed completion timestamps; store/send DB `tasks.complete_date`
