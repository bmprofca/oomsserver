# Auth sessions & logout — Server context

> **Purpose:** Tag when changing login tokens, session listing/revoke, or logout behaviour. Pair with [`CLIENT/context/sessions.md`](../../CLIENT/context/sessions.md).

---

## Mental model

```
tokens table (per login)
  status '1' = active, '0' = inactive
  expire_date (typically +30 days)
        ↓
GET  /auth/sessions
POST /auth/sessions/revoke-others
POST /auth/sessions/:tokenId/revoke
POST /auth/logout  { all_sessions }
```

| File | Role |
|------|------|
| `routes/auth.js` | Login inserts, logout, sessions APIs (`auth` middleware imported here) |
| `middleware/auth.js` | Validates `token` + `username` against `tokens` |

---

## Effective status rules

| Client tab | SQL meaning |
|------------|-------------|
| **active** | `status = '1'` AND (`expire_date` IS NULL OR `expire_date > NOW()`) |
| **inactive** | `status = '0'` OR expired |
| **all** | No status filter |

Serialized row: `status: "active"|"inactive"`, `is_expired`, `is_current` (token header match). **Never return raw `token` to the client** in list payloads (compare server-side only).

---

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/auth/sessions` | `auth` | Query: `status`, `page_no`, `limit`. Returns `data` + `pagination` |
| POST | `/auth/sessions/revoke-others` | `auth` | Sets other **active non-expired** rows for username to `status=0`; keeps current token |
| POST | `/auth/sessions/:tokenId/revoke` | `auth` | Cannot revoke current token |
| POST | `/auth/logout` | headers only | Body `all_sessions` / `allSessions`: if true, deactivate all username tokens; else current token only |

**Route order:** register `/sessions/revoke-others` **before** `/sessions/:tokenId/revoke`.

---

## `tokens` columns (used)

`token_id`, `username`, `token`, `login_method`, `status`, `create_ip`, `last_ip`, `create_date`, `last_used_date`, `expire_date`.

---

## Do not

- Treat expired-but-`status=1` rows as active in the Active tab
- Allow revoke of the caller’s current token via sessions API
