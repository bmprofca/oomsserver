# Utils routes — Server context

> Tag when changing shared utility endpoints under `SERVER/routes/utils.js`.

---

## States and districts

Route:

```js
GET /api/v1/utils/states-and-districts
```

Auth:

- `auth`
- `validateBranch`

Response shape:

```json
{
  "success": true,
  "data": [
    {
      "name": "West Bengal",
      "districts": ["Hooghly", "Howrah", "Kolkata"]
    }
  ]
}
```

Current consumers:

- `CLIENT/src/components/state-district-select.js`
- `CLIENT/src/pages/client-create.jsx` main address step

Notes:

- This endpoint is the shared source of truth for client-side State/District selectors.
- Prefer reusing `StateDistrictSelect` on the client instead of duplicating local hardcoded state lists.

---

## Global search

```
GET /utils/global-search?q=
```

Auth: `auth` + `validateBranch`.

Searches the current branch in parallel (limit **6** each). One failing query returns `[]` for that type and does not fail the whole request.

| Key | Source | Typical path |
|-----|--------|----------------|
| `clients` | `clients` + `profile` (`user_type = client`) | `/client/profile/:username` |
| `firms` | `firms` | `/client/profile/:username/firms` |
| `tasks` | `tasks` + firm + service | `/task/:task_id` |
| `staff` | `branch_mapping` type `staff` | `/staff/view/profile/:username` |
| `ca` | `clients` `user_type = ca` | `/staff/office-assistance/ca-profile/:username` |
| `agents` | `clients` `user_type = agent` | `/settings/agent-profile/:username` |

Empty `q` returns empty arrays. Client modules are **not** searched here — they are filtered in `CLIENT/src/data/softwareModules.js`.

See [`CLIENT/context/global-search.md`](../../CLIENT/context/global-search.md).

