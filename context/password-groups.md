# Password groups — Server context

> **Purpose:** Tag when changing password-group or firm-credential APIs. Pair with [`CLIENT/context/password-groups.md`](../../CLIENT/context/password-groups.md).

---

## Mental model

```
password_groups (branch-scoped)
   └── password_group_firms → firms → clients
```

**Routes:** `SERVER/routes/assistance.js` (password-group section)  
**Auth:** `auth` + `validateBranch` (`branch` header)

---

## Endpoints

| Method | Path | Notes |
|--------|------|------|
| POST | `/assistance/password-group/create` | Create group |
| GET | `/assistance/password-group/list` | Paginated groups |
| PUT | `/assistance/password-group/edit/:group_id` | Edit group |
| DELETE | `/assistance/password-group/delete/:group_id` | Soft-delete group |
| POST | `/assistance/password-group/create-firm-credentials` | One credential: `{ group_id, firm_id, username, password, description? }` — status defaults `'1'` |
| GET | `/assistance/password-group/list-firm-credentials/:group_id` | Paginated. Query: `page_no`, `limit` (max 100), `search` (username, description, firm_name) |
| PUT | `/assistance/password-group/edit-firm-credentials/:credential_id` | Edit username / password / description / status |
| DELETE | `/assistance/password-group/delete-firm-credentials` | Soft-delete by IDs or select-all |

There is **no** `/firm/search`. Firm pickers use `GET /firm/list`. Group import uses `GET /group/list` and `GET /group/group-firms/list`.

---

## Credential status

Column is `'1'` / `'0'` (same as create insert).

**List** returns boolean `status` when the stored value is `true`, `1`, `"1"`, `"true"`, or `"active"`.

**Edit** must normalize the body before write:

| Incoming | Stored |
|----------|--------|
| `true`, `1`, `"1"`, `"true"`, `"active"` | `'1'` |
| anything else when `status` is sent | `'0'` |

Writing a raw boolean (`true`) used to persist as a value the list did not treat as active.

---

## Delete

Body is one of:

```json
{ "credential_ids": ["id1", "id2"] }
```

```json
{ "select_all": true, "group_id": "...", "search": "" }
```

`select_all` / `is_all` resolves matching `credential_id`s in the group (same search as the list), then soft-deletes those IDs. `group_id` is required for select-all. Empty match → 400.

Legacy callers that only send `credential_ids` stay valid.

---

## Do not

- Store edit `status` as a JS boolean without normalizing to `'1'` / `'0'`
- Compare list status only with `== "1"` (misses `true` / `"true"` leftovers)
- Require `credential_ids` when `select_all` is true
