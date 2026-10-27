# Appointments and company Google Calendars

Appointments are branch-scoped and managed through `/api/v1/appointments`. The API requires a valid end-user token, branch context, an active staff/admin branch mapping, and access to the branch's `core` feature. A branch is the OOMS tenant/company boundary for appointment data and Calendar connections.

## Google Calendar architecture

OOMS owns one centrally managed Google OAuth application. Each company admin connects that company's Google account/calendar from **Office → Settings → Google Calendar**. Company admins do not enter OAuth client secrets in the browser. The server stores each branch's refresh token encrypted, linked to that branch, and never returns it to the browser. The Calendar ID defaults to `primary`; use an ID the connected Google account can create events on.

Configure the central OAuth app in **Admin Panel → Settings → Platform Settings → Google Calendar (OOMS OAuth app)**:

- `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`
- `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`

Register this exact authorized redirect URI in Google Cloud:

`{BASE_DOMAIN}/api/v1/appointments/google-calendar/callback`

`BASE_DOMAIN` and `OFFICE_WEB_ORIGIN` are server deployment settings: `BASE_DOMAIN` constructs the callback URL and `OFFICE_WEB_ORIGIN` is the exact Office Web origin used after authorization. Set `OFFICE_WEB_ORIGIN` in production (for example, `https://app.ooms.in`). When it is unset, only `NODE_ENV=development` uses `http://localhost:3000`; other environments default to `https://app.ooms.in` to avoid redirecting production users to localhost. Branch refresh tokens and other platform secrets are encrypted using `secretBox`; the Google OAuth client ID and secret are the exception and are stored as readable values in `platform_settings` to avoid key mismatches between server instances. They are still masked by the Admin Panel API/UI. This means database readers can access the OAuth client secret, so restrict database and backup access. If existing OAuth rows were encrypted with an unavailable key, re-enter both values in Admin Panel → Platform Settings; they cannot be recovered by this change. Do not put credentials in the Office app or `.env`.

The OAuth app needs the Google Calendar Events API and the `https://www.googleapis.com/auth/calendar.events` scope. The branch admin must authorize an account with permission to create events on the selected calendar. Do not commit OAuth app secrets or put them in either frontend app. Google consent-screen publication and verification requirements depend on the app's audience and deployment.

The connection, status, and test endpoints are branch-scoped and admin-only:

- `GET /appointments/google-calendar`
- `POST /appointments/google-calendar/connect` with `{ "calendar_id": "primary" }`
- `POST /appointments/google-calendar/test`
- `GET /appointments/google-calendar/callback` is the one-time Google OAuth callback; its signed random state binds the result to the branch and initiating admin and expires after 10 minutes.

Staff and admins can schedule appointments, but a branch must have a connected Calendar before a new appointment can be saved. New appointments always pin the branch's active Calendar connection ID. Updates, cancellations, and background retries use that pinned connection (even if the branch later reconnects), preventing events from being redirected to another company's calendar. Each event title includes the branch/company name and client name.

## Legacy events and migration

Run the server's existing database migration process to create `appointments`, `appointment_attendees`, branch Calendar connection/state tables, and the appointment connection reference.

Appointments that existed before this migration are marked `legacy`. Their edits, cancellations, and retries continue to use the old shared Calendar settings stored in the database, so existing events remain manageable during migration. New appointments never fall back to that shared Calendar. The old Calendar credentials are removed from the Admin Platform Settings UI/API but retained as inaccessible database values for legacy-event compatibility. Do not delete those rows or change the legacy Google account/calendar until legacy appointments are intentionally migrated or no longer need Calendar updates/cancellations.

Calendar outages do not roll back saved appointments. Sync errors and status are returned and shown to authorized users. A worker retries due failures with bounded exponential backoff, and authorized users can retry from the appointment page. Cancellation marks the appointment cancelled and deletes/cancels its event rather than removing history. Calendar updates use `sendUpdates=all`.

## Appointment API

- `GET /appointments` lists appointments visible in the current branch, with `page` / `limit` pagination (maximum 100 per page), `search`, `from_date`, and `to_date` filters. Admins can see all branch appointments; staff see appointments they created or attend. `mine=true` returns future appointments where the current user is an attendee. Optional `client_username` and `include_cancelled=true` filters are available.
- `GET /appointments/attendees` returns active branch staff/admin invitees and indicates when a profile email cannot receive an invitation.
- `GET /appointments/clients?search=...` searches active clients in the current branch for scheduling.
- `POST /appointments` creates an appointment and selected attendee invitations.
- `PUT /appointments/:appointmentId` updates an appointment and its attendee invitations.
- `DELETE /appointments/:appointmentId` cancels the appointment and invitations.
- `POST /appointments/:appointmentId/sync` retries Calendar synchronization.

Selected attendees receive FCM notifications when an appointment is created, updated, or cancelled, provided they have a registered device token. Push delivery failures do not undo the appointment change.
