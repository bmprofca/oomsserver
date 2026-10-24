# Appointments

Appointments are branch-scoped and managed through `/api/v1/appointments`. The API requires a valid end-user token, branch context, an active staff/admin branch mapping, and access to the branch's `core` feature.

## Google Calendar setup

The server uses one Google Calendar organizer account. Configure an OAuth client and grant the organizer account offline access with the `https://www.googleapis.com/auth/calendar.events` scope. In the admin app, open **Settings → Platform Settings → Google Calendar appointments** and save:

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_ID` (defaults to `primary`)

The OAuth client ID, client secret, and refresh token are stored encrypted in the database and are never returned to the browser. They are read only from database settings, not environment variables. Set a strong `APP_ENCRYPTION_KEY` on the server so database credentials cannot be decrypted from a database dump alone; changing this key later requires re-entering saved credentials. Use **Test connection** on the same settings page to validate OAuth access to the configured calendar. The connected account must have permission to create events on the configured calendar. Never place these credentials in either frontend app or commit populated values. Attendee email addresses are taken from active staff/admin `profile.email` entries in the branch. Appointments with an invalid attendee email are rejected before saving.

## Migration and sync behavior

Run the server's existing database migration process to create `appointments` and `appointment_attendees`. Google Calendar changes are sent with `sendUpdates=all`. Appointment records remain saved if Calendar is temporarily unavailable; the API returns the saved appointment and its `calendar.status` / `calendar.error`. A worker retries eligible failures with bounded exponential backoff, and authorized users can also retry from the appointment page.

Deleting an appointment marks it cancelled and removes/cancels its calendar event rather than deleting the appointment history. The sync status remains visible until the calendar operation succeeds.

## API overview

- `GET /appointments` lists appointments visible in the current branch, with `page` / `limit` pagination (maximum 100 per page), `search`, `from_date`, and `to_date` filters. Admins can see all branch appointments; staff see appointments they created or attend. `mine=true` returns future appointments where the current user is an attendee. Optional `client_username` and `include_cancelled=true` filters are available.
- `GET /appointments/attendees` returns active branch staff/admin invitees and indicates when a profile email cannot receive an invitation.
- `GET /appointments/clients?search=...` searches active clients in the current branch for scheduling.
- `POST /appointments` creates an appointment and selected attendee invitations.
- `PUT /appointments/:appointmentId` updates an appointment and its attendee invitations.
- `DELETE /appointments/:appointmentId` cancels the appointment and invitations.
- `POST /appointments/:appointmentId/sync` retries calendar synchronization.

Selected attendees receive FCM notifications when an appointment is created, updated, or cancelled, provided they have a registered device token. Push delivery failures do not undo the appointment change.
