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
