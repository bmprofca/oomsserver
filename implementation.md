# App-to-app calling: screen sharing

## Objective

Add an optional screen-sharing (screen-casting) control to existing in-app
voice calls. Callers and recipients can share their device screen in the
existing LiveKit call room while keeping the current audio-call experience
unchanged.

The server, office web, client web, and React Native client are maintained in
separate repositories. Their current screen-sharing implementation status is
summarized below.

## Current status

- Server participant tokens now allow microphone and screen-share video
  publishing in the existing accepted call room.
- Office web and client web have screen-share start/stop controls and render
  remote screen tracks. Both production builds complete.
- The React Native call screen has screen-share controls and remote-track
  rendering. Android MediaProjection permission is declared; TypeScript
  checking passes, but device-level capture has not been tested.
- The mobile iOS project now includes and embeds LiveKit's ReplayKit Broadcast
  Extension, with shared app-group configuration and signing entitlements.
  iOS distribution still requires registering the configured App Group for the
  production app and extension identifiers, followed by physical-device tests.

## Existing implementation

- Calls use the configured LiveKit server and `in_app_voice_calls` records.
- A call moves through the existing `ringing`, `accepted`, and terminal
  statuses. Invitations expire after 45 seconds.
- The server issues participant-scoped LiveKit tokens through the existing
  staff, client, and CA token routes. Tokens currently allow microphone
  publishing and subscribing, but do not allow screen-share publishing.
- Call creation, incoming-call delivery, acceptance, and call termination
  should continue to use the existing APIs and Socket.IO events.
- See [docs/in-app-voice-calls.md](./docs/in-app-voice-calls.md) for the
  current call directions, authentication, and route details.

## Proposed behavior

1. Show a **Share screen** action only after the call is accepted and the
   participant has joined the LiveKit room.
2. On activation, ask the operating system or browser for screen-capture
   permission. Start publishing only after the user selects/allows a screen,
   window, or tab.
3. Show the remote screen as a distinct, prominent view, with the sharer's
   name and a clear indication that screen sharing is active. Keep call audio
   controls available.
4. The sharer can stop sharing from the in-call UI or the operating system's
   screen-capture control. The receiver's shared-screen view must disappear
   promptly when the track is unpublished or the publisher disconnects.
5. Stop screen capture on explicit stop, call end, disconnect, or capture
   failure. Ending screen sharing must not end the voice call.
6. Treat screen-share audio as optional and platform-dependent. Do not block
   video-only screen sharing if system-audio capture is unavailable or denied.
7. A participant who declines capture permission can continue the audio call
   normally. Show a recoverable error if capture cannot start.

The initial version should allow either participant to start sharing. If both
participants publish a screen at once, the client should render both or clearly
prioritize one while indicating the other is also active; it must not silently
replace an active share.

## Implementation plan

### 1. Server: extend call-token permissions

Update the shared participant-token issuer in `routes/voiceCalls.js` so that
tokens for an accepted call can publish the LiveKit screen-share video source,
in addition to the existing microphone source. Apply the same permission
change consistently to staff/admin, client, and CA token routes.

- Preserve the existing participant identity, room binding, subscription
  permission, call-status checks, and panel/branch/assignment authorization.
- Do not grant room administration or unrestricted room access.
- Use the `TrackSource` value supported by the installed `livekit-server-sdk`.
  Permit screen-share audio only if the SDK and client platforms support it
  and the product explicitly enables it.
- Keep token issuance restricted to accepted, non-ended calls. Do not accept a
  room name, participant identity, or permission list supplied by the client.
- No database migration is expected: screen-share tracks are transient media
  in the existing call room, not durable call metadata.
- Reuse the existing LiveKit configuration and room cleanup behavior. No
  additional screen-share HTTP endpoint or Socket.IO event is needed for the
  initial version; use LiveKit participant track-published/unpublished events
  for media state.

### 2. Web client

- Use the existing call token and LiveKit room connection.
- Publish a screen track with the browser's supported display-capture API and
  handle permission denial, cancelled selection, unsupported browsers, and
  browser-generated track termination.
- Listen for remote screen-share track publication, subscription, unpublish,
  and participant disconnect; attach and detach the rendered view safely.
- Stop all local display-capture tracks when sharing stops or the call ends.

### 3. Mobile clients

- Integrate the platform-appropriate LiveKit screen-capture flow (for example,
  Android MediaProjection or iOS ReplayKit) through the mobile LiveKit SDK.
- Request and explain OS permissions at the point the user starts sharing.
- Handle platform-required foreground service, broadcast extension, or system
  picker setup in the mobile app. These platform requirements cannot be
  completed in this backend repository.
- Handle OS-level stop, app backgrounding, interruptions, and call teardown by
  stopping/publishing track changes and updating the in-call UI.

### 4. UI and accessibility

- Provide start/stop controls with accessible labels and an active-sharing
  state. Avoid relying on color alone to communicate state.
- Show a visible privacy indicator while the participant's screen is being
  captured and identify who is sharing on the receiver's screen.
- Keep audio mute, speaker/output selection, and end-call controls usable while
  a screen is visible.
- On small screens, support switching between the shared screen and call
  controls/participant view without losing call state.

## Security and privacy

- Screen content can expose notifications and sensitive application data.
  Explain this before the first share and rely on the OS/browser permission
  prompt as the capture authorization.
- Never capture or upload screen content through the OOMS API or persist it in
  call history. Media must flow through the configured LiveKit room.
- Retain existing server-side participant authorization for token requests.
  A caller must not be able to obtain a screen-share-capable token for another
  participant or an unrelated room.
- Revoke capture promptly on stop/end/disconnect, and do not keep background
  capture running after leaving the call.

## Validation checklist

### Server

- Verify accepted staff, client, and CA participants can receive a token that
  permits microphone and screen-share publishing.
- Verify ringing, rejected, ended, expired, unauthorized, and cross-branch or
  unassigned calls cannot obtain a usable token.
- Verify the existing microphone call flow, subscription, and room cleanup are
  unchanged.

### Web and mobile clients

- Verify permission granted, denied, dismissed, and unsupported-device flows.
- Verify remote screen appears and disappears on publish/unpublish, publisher
  disconnect, and call end.
- Verify local OS/browser stop ends sharing without ending the call.
- Verify simultaneous sharing does not silently hide or replace a participant's
  screen.
- Verify audio remains connected and controllable throughout share start/stop.
- Verify no capture remains active after leaving the call or backgrounding/
  terminating the app.

## Rollout

1. Implement and test screen-track rendering/capture in supported app clients.
2. Deploy the server token-permission change before enabling the Share screen
   action in clients; older clients will continue using the existing
   microphone-only behavior.
3. Enable the UI only for platforms whose installed LiveKit SDK and OS capture
   flow have passed the validation checklist.
4. Monitor call connection failures and client-reported capture errors. Roll
   back by hiding the client action and reverting the additional publish
   permission; no database rollback is required.

## Not in scope

- Recording, replay, or server-side storage of shared content.
- Remote control of the sharer's device.
- Changes to call invitations, call history, billing, or call-provider setup.
