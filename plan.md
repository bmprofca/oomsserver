# In-app voice calling implementation plan

## Goal and scope

Add secure, one-to-one, app-to-app voice calls so authorized branch admins and staff can call clients inside the mobile app. The client receives an incoming-call screen and can accept or decline. Include mute, speaker, call timer, and hang up.

This feature is voice only: no video, group calls, screen sharing, chat, PSTN dialing, or call recording. Calls require both participants to have the app, an account, network access, and microphone permission.

## Existing system and key distinction

The server already has `/broadcast/call` routes, branch call-channel settings, staff extensions, PBX credentials, and call logs. Its `/initiate` endpoint sends a phone number and extension to the PBX. That is external phone/PBX click-to-call, not app-to-app audio.

Keep that PBX flow intact. Implement in-app calling as a separate channel and data model; do not send app-call invites to `/initiate`, require PBX extensions, or treat a PBX acknowledgment as proof that an app call connected.

The backend already uses Express, MySQL, Socket.IO, and Firebase Admin/FCM. Reuse its authentication, branch scoping, migration conventions, and push-token infrastructure where appropriate. The React Native CLI mobile app is in `C:\Projects\oomsapp`; it already registers FCM tokens for its staff/admin and client panels.

## Recommended architecture

Use **LiveKit Cloud** as the managed WebRTC audio media service. The backend authorizes calls, creates provider rooms and short-lived participant tokens, persists call state, and sends incoming-call notifications. The mobile apps connect directly to LiveKit for audio; do not relay media through the OOMS API or Socket.IO.

Use authenticated backend APIs for call lifecycle and LiveKit webhooks for authoritative provider events. Use push notifications only to wake/alert the recipient; the app must fetch call details from the authenticated API before showing or accepting an invite. Never put LiveKit credentials, access tokens, or sensitive client data in push payloads.

This recommendation avoids operating a self-hosted TURN/SFU fleet while providing mobile WebRTC SDKs. Confirm region, data residency, capacity, pricing, and vendor terms before production. If an existing organizational voice provider is mandatory, reassess the provider before implementation rather than building two media integrations.

## Packages and platform setup

Install only the packages for the actual mobile framework; do not install React Native and Flutter stacks together. Pin versions compatible with the app's React Native version and commit its lockfile.

### Backend in this repository

```sh
npm install livekit-server-sdk
```

Use the existing `firebase-admin` dependency for FCM. Add no second socket or database package for calls. Configure LiveKit API credentials through the deployment secret manager/environment, never source control. Keep secrets separate by environment and rotate them.

### React Native CLI mobile app

Installed in `C:\Projects\oomsapp`:

```sh
npm install @livekit/react-native @livekit/react-native-webrtc livekit-client
```

The app reuses its existing Firebase Messaging and Notifee packages for incoming notifications. iOS PushKit/CallKit and Android ConnectionService native incoming-call UI require further native integration and provider credentials; normal FCM notifications provide alert-and-tap behavior, not VoIP wake-up.

## Implementation phases

### 1. Product and platform decisions

- Confirm mobile framework, minimum iOS/Android versions, deployment method, and existing push setup.
- Confirm the client can receive calls when the app is backgrounded or terminated, and define fallback behavior when the recipient is offline.
- Confirm who may call whom: default policy is an active, accepted admin/staff member calling a client linked to the same active branch. Define whether clients may call back separately; do not enable it implicitly.
- Select LiveKit Cloud region and environments; agree on retention for call metadata and operational logs. Audio recording is out of scope.

### 2. Backend authorization, state, and provider integration

- Add a dedicated in-app voice-call migration and service, without changing the PBX tables or endpoint behavior.
- Persist a call record with an opaque call ID, branch, caller and client identities, provider room/call reference, lifecycle status, timestamps, end reason, and idempotency key. Add indexes for active calls, branch history, and provider webhook lookup. Avoid storing audio or unnecessary call payloads.
- Model lifecycle explicitly: `created/ringing`, `accepted`, `rejected`, `cancelled`, `missed`, `ended`, and `failed`, with validated transitions and server-owned timestamps.
- Add authenticated endpoints under the existing call route for:
  - creating an invitation;
  - retrieving an authorized pending/active call;
  - accepting or declining;
  - cancelling or ending;
  - issuing a short-lived LiveKit room token only to an authorized participant;
  - fetching paginated, role-appropriate call history if product requires it.
- Derive the caller from authenticated identity, not a caller ID supplied by the client. Validate branch membership, active account status, admin/staff role, client-to-branch relationship, call feature availability, and recipient eligibility on every relevant operation.
- Enforce one active invitation per recipient (and a defined per-caller limit), request idempotency, invitation expiry, rate limits, and safe concurrent accept/decline/end transitions.
- Implemented in the server migration `20261003_in_app_voice_calls.sql`, with isolated `/api/v1/voice-calls` endpoints and LiveKit webhook verification. Feature activation is gated by `IN_APP_VOICE_CALLS_ENABLED`.
- Notify the recipient using a minimal push payload containing only an opaque call ID and event type. Reuse existing FCM delivery for supported app states. Implement and test iOS VoIP PushKit/APNs separately; ordinary FCM data pushes are not a substitute for CallKit VoIP wake-up.
- Validate LiveKit webhooks using the provider's signing secret, make webhook processing idempotent, and use provider events to reconcile missed/ended calls. Do not trust the mobile client alone to report authoritative call outcomes.
- Add structured, privacy-minimal logs and metrics. Redact tokens, API keys, phone numbers, and push payloads; define retention and access policy for call history.

### 3. Mobile call experience

- Add an authorized client list/contact action for admins and staff, gated by server capability and eligibility responses.
- Show outgoing `Calling...`, incoming call UI with caller identity, and clear accepted, declined, missed, busy, expired, and network-failure states.
- Integrate native incoming-call surfaces: CallKit on iOS and ConnectionService/notification UI on Android. Handle app foreground/background/terminated states, push tap, duplicate pushes, and stale invitations.
- Request microphone permission at the point of use with clear explanation; handle denied/revoked permission without leaving a call stuck in ringing.
- Connect to the LiveKit room only after the authenticated accept flow. Provide mute, speaker/audio-route controls, call duration, and explicit hang up.
- Implemented in the React Native CLI app using its existing FCM registration for invitations. Background/terminated notifications open the incoming screen on tap; native CallKit/PushKit wake-up is not included yet.
- Recover from temporary network changes and app lifecycle transitions; if media reconnect fails, show a recoverable state and eventually terminate/reconcile the call.
- Never rely on a push payload alone to authorize a call or join a room. Do not expose provider API secrets in the app.

### 4. Operations and rollout

- Configure separate LiveKit projects/credentials and push credentials for development, staging, and production. Restrict secret access and rotate credentials.
- Add provider webhook URL, signature verification, health/alerting, and metrics for invite delivery, answer rate, setup time, failures, reconnects, and call duration.
- Document operational response for provider outage, webhook backlog, push failure, credential rotation, and emergency feature disablement.
- Follow [the deployment and API guide](./docs/in-app-voice-calls.md); a web app can later use the same call lifecycle and LiveKit room token contract.
- Release behind a server-controlled feature flag, initially enable for internal/test branches, then stage rollout with monitoring and a rollback switch. Keep the PBX feature independently configurable.
- Confirm privacy policy, user consent/notice, applicable call metadata retention, and app-store permission disclosures before launch.

## Quality and acceptance criteria

### Automated coverage

- Unit tests cover authorization rules, state transitions, idempotency, expiry, and provider/webhook signature validation.
- API tests prove cross-branch calls and unauthorized roles/targets are rejected, repeated requests do not create duplicate calls, and invalid transitions cannot issue room tokens.
- Push tests cover invalid/unregistered tokens and notification retries without leaking call credentials.
- Mobile tests cover permission states, incoming/outgoing state transitions, duplicate/stale pushes, background/terminated handling, and hang-up cleanup.

### Device and release checks

- Verify real iOS and Android devices across Wi-Fi/mobile-data transitions, app foreground/background/terminated states, locked screen, denied microphone permission, and force-quit behavior.
- Verify two authorized devices can establish clean two-way audio, mute/unmute, change audio route, and end the call; check for no residual microphone capture after hang-up.
- Verify unanswered calls expire, missed calls reconcile after push/webhook delays, and provider/network failures produce accurate UI and logs.
- Load-test invitation creation, webhook handling, and push fan-out at the expected peak; validate provider quotas and operational alerts.

The feature is ready to roll out only when the authorization, lifecycle, push, native incoming-call, failure-recovery, privacy, and staged-rollout checks above pass on both platforms.
