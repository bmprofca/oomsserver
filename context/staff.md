# Staff list & invite — Server context

> **Purpose:** Tag when changing staff invite, list, or status-OTP APIs. Pair with [`CLIENT/context/staff.md`](../../CLIENT/context/staff.md). OTP types live in `SERVER/helpers/authProfile.js`.

---

## Mental model

```
branch_mapping (type = 'staff', branch-scoped)
   └── users + profile
```

**Routes:** `SERVER/routes/staff.js` mounted at **`/settings/staff`** (`SERVER/routes/index.js`).  
**Auth:** `auth` + `validateBranch` (`branch` header).

User lookup for invite uses `resolveSoftwareUserByContact` (email, username, or last-10 mobile digits).

---

## Endpoints

| Method | Path | Notes |
|--------|------|------|
| GET | `/settings/staff/list` | Paginated. Query: `search`, `page`, `limit`, `status` (`active`/`inactive`), `permission_role_id`. Returns `profile.image` (accepted and pending). `is_accepted` boolean, `status` boolean (branch mapping active). |
| POST | `/settings/staff/check-user` | Find software user before invite. Body: `email` **or** `mobile` (or `identifier`). Empty → 400 `"Email or mobile number is required"`. Not found → 404. Already mapped → success message without `data.username` (already exists / not accepted yet). |
| POST | `/settings/staff/create` | `{ username, designation }`. Creates `branch_mapping` (`is_accepted: "0"`), invitation token, invitation email. |
| POST | `/settings/staff/change-status/send-otp` | `{ username, status: 'active'\|'deactive' }`. OTP to **session admin’s** registered mobile via `sendSmsOtp` (login SMS channel, not branch SMS). |
| PUT | `/settings/staff/change-status` | `{ username, status, otp }`. **Requires 6-digit `otp`**. Bound to remark `staff_status:${username}:${status}`. Admin-only. |
| GET | `/settings/staff/profile` / `/:username` | Staff profile for the view page. |
| POST | `/settings/staff/delete` | Soft-delete mapping by `map_id`. |
| GET | `/settings/staff/search-by-name` | Name search. |
| GET | `/settings/staff/settings-list` | Settings hub card metadata. |

---

## Check-user (email or mobile)

```js
const email = String(req.body?.email || "").trim().toLowerCase();
const mobileDigits = String(req.body?.mobile || "").replace(/\D/g, "");
const mobile = mobileDigits.length >= 10 ? mobileDigits.slice(-10) : "";
const identifier = String(req.body?.identifier || email || mobile || "").trim();
```

`resolveSoftwareUserByContact(pool, identifier)` already treats `@` as email and ≥10 digits as last-10 mobile.

Do not require email-only. Client sends `{ email }` or `{ mobile }`.

---

## Status OTP

| Constant | Value |
|----------|--------|
| `STAFF_STATUS_OTP_TYPE` | `"staff_status"` (`helpers/authProfile.js`) |
| Remark | `staff_status:${username}:${status}` via `staffStatusOtpRemark` |

- OTP is stored against the **admin session username**, not the staff username.
- Destination is the admin profile mobile (`normalizeMobileDigits` + country code).
- `PUT /change-status` without a valid unused OTP → 400.
- Restart **SERVER** after changing these routes (`node server.js` does not hot-reload).

---

## List images

`GET /list` includes `profile.image` (built URL) for **pending and accepted** staff so avatars can render on `/settings/staff-list` and `/staff/view`.

---

## Do not

- Accept only `email` on `/check-user`.
- Allow status change without OTP.
- Send status OTP on a branch SMS channel — use the same channel as login (`sendSmsOtp`).
- Bind OTP to the staff mobile; it must go to the acting admin.
