# In-app voice calls

In-app voice calls use the configured LiveKit server and the
`in_app_voice_calls` table. Calls are audio-only and invitations expire after
45 seconds.

## Supported call directions

- Branch admins and staff can call active clients and CAs in their branch.
- Branch admins and staff can also call other active admins and staff in the
  same branch. Recipients can answer in the office web app or mobile app.
- Clients can call an admin or staff member only when that person is assigned
  to one of the client's active tasks. This assignment is checked again when
  creating the invitation.
- The client and office web apps receive incoming-call events over Socket.IO.
  They query the incoming-call endpoint once after socket authentication or
  reconnection to recover an invitation sent while disconnected. Mobile
  clients and CAs continue to receive incoming-call push notifications.
- Callers hear a ringback tone while an invitation is ringing; recipients hear
  an incoming-call tone. Both stop when the call is answered or ends.

## Database update

After the original voice-call and LiveKit settings migrations, run:

```powershell
npm run migrate:voice-call-direction
```

This adds `initiated_by` and `recipient_panel` plus the incoming-call indexes.
The migration script is safe to rerun.

## Main API routes

All routes are mounted under `/api/v1/voice-calls`.

| Route | Session | Purpose |
|---|---|---|
| `POST /create` | Branch admin/staff | Call a same-branch client, CA, admin, or staff using `recipient_username` and `recipient_panel` |
| `GET /capability` | Branch admin/staff | Check whether a client, CA, admin, or staff member can be called |
| `POST /client/create` | Client | Call assigned active-task staff |
| `GET /client/capability` | Client | Check assigned-staff call availability |
| `GET /incoming` | Branch admin/staff | Restore a ringing client or staff call after socket reconnection |
| `GET /staff/:call_id` | Called admin/staff | Load an incoming staff-to-staff call |
| `POST /staff/:call_id/respond` | Called admin/staff | Accept or decline an incoming staff-to-staff call |
| `GET /client/incoming` | Client | Restore a ringing admin/staff call after socket reconnection |
| `GET /ca/incoming` | CA | Poll for an incoming admin/staff call |
| `POST /:call_id/respond` | Called admin/staff | Accept or decline an incoming client call |
| `POST /client/:call_id/respond` | Client | Accept or decline an incoming admin/staff call |
| `POST /ca/:call_id/respond` | CA | Accept or decline an incoming admin/staff call |

Participant status, token, and end routes remain scoped to their respective
authenticated panel. Do not accept a client or staff identity from a request
body as a substitute for the authenticated session.

Incoming web invitations use the `voice_call_incoming` Socket.IO event. Office
sessions authenticate with the existing `auth` event; client web sessions use
`voice_call_auth`, which validates the client token and selected active profile.
Active-call status continues to use the participant-scoped REST routes.
