# Calls and notification delivery

Migration 068 adds tenant-scoped calls, participant leases, consent ledgers, correction history, notification devices, source preferences, delivery planning and delivery history. Configuration availability is reported separately from live provider acceptance.

## Calls

Open **Call** in a conversation header. Calls support microphone/camera toggles, screen sharing, device selection, participant removal, host termination and private recording downloads. Camera and microphone start disabled. Tokens restrict generated room/participant identities and expire after 60 seconds. They grant no room administration or recording rights. LiveKit must use `room.auto_create: false` so an old token cannot recreate a closed room.

Modes are immutable:

- **No recording:** no recording or retained transcript; the client does not render caption packets.
- **Transient captions:** explicit consent before admission; peer caption packets disappear after eight seconds and never enter the API, database, index or offline cache.
- **Retained recording:** explicit consent before admission; Egress writes a private MP4. Participant captions retain authenticated speaker identity, timing and correction history. Retention defaults to 30 days and accepts 1–90 days through the API.

Captions currently come from participants typing captions. Automatic speech recognition, diarization from recorded audio, automatic summary/chapter generation and live voice-agent audio are **not implemented**. Capabilities explicitly report `voiceAgents: false` and `transcription: participant_captions`. Agent consent is stored separately and never enables an agent implicitly. These remain open full-product work.

Hosts can publish reviewed summaries, chapters and proposed actions citing retained segments. Proposed actions do not execute tools or create tasks automatically. Optimistic transcript corrections append history and invalidate derived notes. A trigger maintains the existing retained-transcript source, reusing R09 lexical/vector jobs, current-access checks, source versions and correction propagation.

Admission requires an active account session, current conversation access and consent for caption/recording modes. Reconciliation checks session validity, account authority, message permission, access and participant leases. It removes invalid participants, closes ended/expired calls and purges expired media/corrections. Shared channels prohibit recording and transcription under their agreed no-recording policy.

Consent withdrawal enters `ending`; the API never claims recording has already stopped. Revocation is asynchronous (normally the three-second worker interval); provider/worker outages can extend that interval. Production needs continuously running workers, health alerts and operational stop procedures. Token expiry alone does not disconnect an existing WebRTC connection. Ambiguous recording starts are reconciled against provider jobs and never blindly retried.

`DELETE /v1/calls/:id/content` immediately invalidates evidence and hides the call; the worker retries physical deletion. Downloads and exports require current access. Storage paths and provider credentials stay server-side. Exports include every retained segment within the enforced 2,000-segment/200,000-character limit. Production recording volumes require private permissions, encryption, quotas, backups and independent media/load qualification. The loopback Docker example is not an Internet deployment configuration.

API entry points include conversation call history/creation and `/calls/:id/join`, `/heartbeat`, `/leave`, `/end`, `/remove`, `/mute`, `/transcript`, `/notes`, `/recording`, `/export` and `/content`. Transcript history accepts `afterId`; call history accepts `before`. Caption requests cannot specify another speaker identity.

## Notification delivery

**Notifications → Notification settings** configures push, immediate/hourly/daily email, IANA timezone, quiet hours, batching, priority, escalation and device routing. Daily digests target 9 AM locally and defer through quiet hours. Scheduling walks UTC instants across DST gaps/repeats. Channel, thread and agent controls add source-specific mute/high-priority overrides. Existing global and conversation mute settings retain precedence. Pending sends recheck unread state, access and preferences.

Subscriptions/tokens are encrypted with the identity key and bound to member, account authority and session. Registration expires after 30 days and needs renewal. Revocation erases the target. Web Push accepts known provider endpoints rather than arbitrary URLs. Routing selects all devices or the most recently **registered/renewed** device; it does not infer device foreground state.

Push and email carry a generic prompt to open Orbit. They contain no message excerpts, conversation names, transcript text or resource URLs. The authenticated app rehydrates currently accessible content. The service worker never caches private APIs. Opaque expiring receipt capabilities acknowledge receipt/opening without returning identity/content data. Provider acceptance is `sent`; `received`/`opened` require client receipts. Ambiguous non-idempotent sends remain `outcome_unknown`. Definite retryable errors use bounded backoff/fenced leases. Email retries use stable batch identifiers and generic content.

Mailpit/Gmail/Resend use the existing email adapters. Web Push uses VAPID. APNs/FCM adapters and encrypted native registration exist, but require registered applications and physical-device acceptance tests. This repository has no native desktop/iOS/Android clients yet. Browser Web Push supplies OS notifications on supported browsers/platforms; mobile PWAs additionally depend on platform install/permission requirements.

Recipient-private delivery history retains 90 days. Presence snapshots include completeness, sample time and lease duration. `/v1/activity?membershipIds=<comma-separated UUIDs>` qualifies up to 200 requested members. A truncated sample does not prove omitted members are offline.

## Local operation and verification

`npm run local:up` starts LiveKit, Redis and Egress alongside the existing local services, and generates/reuses private VAPID keys without editing `.env`. `npm run local:down` stops those project containers. MP4 output lives in `.data/call-recordings`, outside public directories. The SFU advertises mapped loopback and internal Docker candidates; enabling its loopback ICE interface inside Docker incorrectly directs forwarded traffic to the container loopback.

Run security/scheduling checks:

```sh
npm run test -w @ao/api -- test/calls-delivery.test.ts test/notifications.test.ts test/activity.test.ts --no-file-parallelism
```

With the local media containers running and the web app built, verify real media:

```sh
CI=1 PLAYWRIGHT_PORT=3100 \
LIVEKIT_TEST_URL=ws://localhost:7880 \
LIVEKIT_TEST_KEY=orbit-local \
LIVEKIT_TEST_SECRET=local-development-only-do-not-use-in-production-32 \
LIVEKIT_RECORDING_TEST=true \
npx playwright test tests/e2e/calls-delivery.spec.ts
```

The fixed key is exclusively for the loopback Docker development stack. The suite exchanges real synthetic microphone/video tracks between Chromium instances, checks decoded video and verifies an actual MP4 from Egress after consent. Regular browser jobs skip media acceptance without this environment. Live VAPID/APNs/FCM device acceptance, production TURN/WSS, Safari/mobile media, screen-sharing chooser behavior, network interruption and load qualification remain separate acceptance work.

Provider references: [LiveKit SDK](https://docs.livekit.io/reference/server-sdk-js/), [self-hosted Egress](https://docs.livekit.io/transport/self-hosting/egress/), [server configuration](https://github.com/livekit/livekit/blob/master/config-sample.yaml).
