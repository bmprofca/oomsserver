# Server context docs

Modular agent playbooks for the OOMS API. Tag the relevant file(s) instead of re-explaining.

## Files

| File | When to tag |
|------|-------------|
| [`gst-change.md`](./gst-change.md) | Branch GST, tax rates, fees/totals, dropped tax columns, `helpers/gst.js` |
| [`account-profile.md`](./account-profile.md) | Logged-in user profile (`/account`), contact OTP, profile image |

## Pair with client

| Server | Client |
|--------|--------|
| `gst-change.md` | `CLIENT/context/gst-change.md` |
| `account-profile.md` | `CLIENT/context/account-profile.md` |
| — | `CLIENT/context/layout.md` (shell width; client-only) |
| — | `CLIENT/context/settings-branch.md` (Branch Settings UI + GST Config tab) |
