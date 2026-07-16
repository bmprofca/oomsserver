# Account profile API — Server context

> **Purpose:** Tag this doc when changing the logged-in user profile, contact OTP verification, or `/account` routes. Pair with [`CLIENT/context/account-profile.md`](../../CLIENT/context/account-profile.md).

> **Do not** create or alter DB tables for this feature. Uses existing `profile` and `otps` tables only.

---

## Mental model

```
Logged-in username (auth headers)
        ↓
profile row (status = '1')
        ↓
GET / update / image / contact OTP
```

- **Not branch-scoped.** Middleware: `auth` only — **never** `validateBranch`.
- **Do not** require or read `branch` header.
- **Do not** return branch role / mapping data on profile responses.
- Login is **OTP-based** (no user password on `users`). Do not add change-password for software users here.

Mounted at: `router.use("/account", accountRoutes)` in `routes/index.js`.

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/account/profile` | `auth` | Active profile for session username |
| PUT | `/account/profile` | `auth` | Update profile fields |
| POST | `/account/profile/image` | `auth` | `{ image: "<public url>" }` → B2 + store filename |
| POST | `/account/profile/contact/send-otp` | `auth` | Start contact-change OTP |
| POST | `/account/profile/contact/verify-otp` | `auth` | Verify OTP (marks used) |

Also related (branch headers OK): `GET /utils/care-of-types` → `["S/O","W/O","D/O"]`.

---

## Profile columns used (existing `profile` table)

Editable / returned: `name`, `care_of`, `guardian_name`, `date_of_birth`, `gender`, `mobile`, `email`, `pan_number`, address fields (`country`, `state`, `city`, `district`, `village_town`, `address_line_1`, `address_line_2`, `pincode`), `image`.

Read-only in response: `profile_id`, `username`, `user_type`, `status`, `create_date`, `country_code` (returned for completeness; **never updated from client**).

### Country code / mobile

- Keep existing `country_code` in DB on every PUT (`country_code: existing.country_code || "+91"`).
- Ignore any client-sent `country_code`.
- Normalize mobile to **10 digits** only.

---

## Contact change OTP

OTP type constant: `CONTACT_CHANGE_OTP_TYPE = "contact_change"` in `helpers/authProfile.js`.

| Change | OTP sent to | Channel |
|--------|-------------|---------|
| Email only | Current **mobile** | SMS (`sendSmsOtp`) |
| Mobile only | Current **email** | Email (`SendMail`) |
| Both | Current **mobile** | SMS |

`field` body values: `"email"` | `"mobile"` | `"both"`.

Flow:

1. Client detects email/mobile change → `POST .../contact/send-otp` with `{ field }`.
2. Client may `POST .../contact/verify-otp` with `{ field, otp }` (optional UX step).
3. Client `PUT /account/profile` with new fields + `contact_otp` when contact changed.
4. Server re-checks OTP on PUT if email/mobile differs; rejects with `requires_otp: true` if missing/invalid.

OTP rows live in existing `otps` table (5-minute expiry pattern, same as auth login OTP). Invalidate prior unused `contact_change` OTPs for the username before inserting a new one.

---

## Image upload

1. Client uploads binary to OneSaaS → public URL.
2. `POST /account/profile/image` with `{ image: url }`.
3. Server `downloadAndUploadProfileImage` → B2 `media/profile/image/{filename}`.
4. Updates `profile.image` filename; response returns proxy URL via `buildProfileImageUrl`.

---

## Hard rules

- [ ] No `validateBranch` on `/account/*`
- [ ] No branch fields in JSON responses
- [ ] Never overwrite `country_code` from request body
- [ ] Contact change requires valid OTP on PUT
- [ ] No new tables / columns
- [ ] Care-of values are free strings in DB; UI constrains to S/O, W/O, D/O via utils API

---

## Key files

| Path | Role |
|------|------|
| `routes/account.js` | All `/account` handlers |
| `helpers/authProfile.js` | `CONTACT_CHANGE_OTP_TYPE` |
| `helpers/b2Storage.js` | `downloadAndUploadProfileImage` |
| `helpers/mediaUrl.js` | `buildProfileImageUrl` |
| `helpers/smsOtp.js` | `generateOtp`, `sendSmsOtp` |
| `routes/utils.js` | `GET /care-of-types` |
| `middleware/auth.js` | `auth` only |

Client mirror: [`CLIENT/context/account-profile.md`](../../CLIENT/context/account-profile.md)
