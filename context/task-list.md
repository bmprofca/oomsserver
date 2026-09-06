# Task list — Server context

> **Purpose:** Tag when changing task list / staff-tasks / task-detailed payloads used by table UIs (complete date, compliance period, CA approval). Pair with [`CLIENT/context/task-list-display.md`](../../CLIENT/context/task-list-display.md).

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

## CA approval

List/report rows with an assigned CA should include:

- `has_ca`, `ca` (snipped profile)
- `ca_approval`: `'pending' | 'sent' | 'complete'` (null when no CA)

| Endpoint | Notes |
|----------|--------|
| `GET /task/list` | `t.ca_approval` selected + mapped |
| `report/task-detailed` | under `assignment.ca_approval` |
| `report/staff-tasks` | top-level `has_ca`, `ca`, `ca_approval` |

---

## Compliance period

List/report rows should include where available:

- `compliance_year`, `compliance_period`
- service `frequency` (for label building on client)

Client builds the human label via `getTaskCompliancePeriodLabel`.

---

## Do not

- Strip `complete_date` from `/task/list` “for slimming” — UI depends on it for completed rows
- Strip `ca_approval` from list feeds when `has_ca` — staff column shows approval under CA name
- Trust only client-computed completion timestamps; store/send DB `tasks.complete_date`
