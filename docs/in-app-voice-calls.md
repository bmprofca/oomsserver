# In-app voice calls

In-app voice calls use the configured LiveKit server and the
`in_app_voice_calls` table. Calls support audio and screen-share video, and
invitations expire after 45 seconds. Screen sharing uses the existing
accepted-call room and participant token; clients must request OS/browser
capture permission and publish a LiveKit screen-share video track. Screen-share
audio is not enabled.

## Supported call directions

- Branch admins and staff can call active clients and CAs in their branch.
- Branch admins and staff can also call other active admins and staff in the
  same branch. Recipients can answer in the office web app or mobile app.
- Clients can call an admin or staff member only when that person is assigned
  to one of the client's active tasks. This assignment is checked again when
  creating the invitation.
- Apps check call capability with the authenticated
  `voice_call_capability_watch` Socket.IO event and receive
  `voice_call_capability_update` whenever the recipient's presence changes.
  The response separates `can_call` from `is_online`: a registered mobile
  push target can receive a call while offline, and a connected web or mobile
  app is reported online. The HTTP capability routes remain available for
  older clients.
- The client and office web apps receive incoming-call events over Socket.IO.
  They query the incoming-call endpoint once after socket authentication or
  reconnection to recover an invitation sent while disconnected. Mobile
  clients and CAs continue to receive incoming-call push notifications.
- If an account is signed in on multiple devices or app sessions, the first
  session to accept an incoming call owns that call. Other sessions receive a
  `voice_call_answered` event, stop ringing, and dismiss the incoming-call UI.
  Mobile sessions also receive a push naming the person who answered and
  cancel their local incoming-call notification. Other sessions cannot obtain
  a LiveKit join token; the accepting session can safely repeat its accept or
  reconnect request.
- Callers hear a ringback tone while an invitation is ringing; recipients hear
  an incoming-call tone. Both stop when the call is answered or ends.
- After an accepted call ends, clients disconnect from LiveKit first and the
  server removes the room after a short grace period so the other participant
  can observe the ended status and disconnect cleanly.
- When a new call is initiated, the server reconciles active call records with
  LiveKit. If the room for an old active record no longer exists, the record is
  ended so a missed LiveKit end webhook cannot block future calls.
- LiveKit join events record when a call has actually connected. If its
  participants disconnect or its room finishes, the server releases the active
  call so a closed browser or app cannot block the next call. If a call is
  accepted but no participant joins, an empty room is reconciled after a
  45-second join grace.
- When an authenticated call socket disconnects, the server checks LiveKit for
  accepted calls involving that account after five seconds, then retries at 30
  and 90 seconds. This allows LiveKit's transport-disconnect detection to settle.
  An empty or missing room is marked ended; a room with a participant remains
  active.
- Configure the LiveKit webhook to deliver `participant_joined`,
  `participant_left`, and `room_finished` events to
  `/api/v1/voice-calls/webhook`; the endpoint verifies each event signature.

## Database update

After the original voice-call and LiveKit settings migrations, run:

```powershell
npm run migrate:voice-call-direction
npm run migrate:voice-call-sessions
npm run migrate:voice-call-connection
```

These add `initiated_by` and `recipient_panel`, the incoming-call indexes,
accepted-session binding, and per-session ringing/decline tracking. A recipient
session that declines dismisses only its own incoming-call UI; the call is
rejected and the LiveKit room removed only after every session that was notified
has declined. Connection tracking distinguishes a call that disconnected after
joining from one still within its initial join grace. The migration scripts are
safe to rerun.

## Main API routes

All routes are mounted under `/api/v1/voice-calls`.

| Route | Session | Purpose |
|---|---|---|
| `POST /create` | Branch admin/staff | Call a same-branch client, CA, admin, or staff using `recipient_username` and `recipient_panel` |
| `POST /client/create` | Client | Call assigned active-task staff |
| `GET /capability` | Branch admin/staff | Legacy HTTP capability check; current apps use Socket.IO |
| `GET /client/capability` | Client | Legacy HTTP capability check; current apps use Socket.IO |
| `GET /incoming` | Branch admin/staff | Restore a ringing client or staff call after socket reconnection |
| `GET /staff/:call_id` | Called admin/staff | Load an incoming staff-to-staff call |
| `POST /staff/:call_id/respond` | Called admin/staff | Accept or decline an incoming staff-to-staff call |
| `GET /client/incoming` | Client | Restore a ringing admin/staff call after socket reconnection |
| `GET /ca/incoming` | CA | Poll for an incoming admin/staff call |
| `GET /history` | Branch admin/staff | Paginated call history for the signed-in user and active branch |
| `GET /client/history` | Client | Paginated call history for the signed-in client profile |
| `GET /ca/history` | CA | Paginated call history for the signed-in CA and active branch |
| `POST /:call_id/respond` | Called admin/staff | Accept or decline an incoming client call |
| `POST /client/:call_id/respond` | Client | Accept or decline an incoming admin/staff call |
| `POST /ca/:call_id/respond` | CA | Accept or decline an incoming admin/staff call |

Participant status, token, and end routes remain scoped to their respective
authenticated panel. Do not accept a client or staff identity from a request
body as a substitute for the authenticated session.
History routes accept `page`, `limit` (maximum 100), `status`, and
`direction` (`incoming` or `outgoing`) query parameters. Results contain
participant, branch, outcome, timestamp, and call-duration details.

Incoming web invitations use the `voice_call_incoming` Socket.IO event. Office
sessions authenticate with the existing `auth` event; client web sessions use
`voice_call_auth`, which validates the client token and selected active profile.
Mobile staff use `auth`, mobile clients use `voice_call_auth`, and mobile CAs use
`ca_voice_call_auth` to register their live call presence. Each authenticated
session may request a capability snapshot with
`voice_call_capability_watch`, passing a unique `subscription_id`,
`recipient_username`, and
`recipient_panel`; the server validates assignments and branch membership
before responding. Presence transitions send a fresh capability snapshot in
`voice_call_capability_update`; clients should send
`voice_call_capability_unwatch` when the view no longer needs updates.
Capability checks treat an active Socket.IO session or a registered FCM token
for the target panel as reachable, regardless of whether the caller is web or
mobile. `is_online` still indicates an active app session; a push-reachable
recipient can have `can_call: true` while `is_online: false`. FCM delivery
requires an active device token, network access, and notification permission.
The REST capability routes are retained for older clients; current mobile and
web clients use the socket watch.
Active-call status continues to use the participant-scoped REST routes.
