# Files, clients, and commercial controls

This increment adds locally verified file governance and commercial controls. It does not establish signed distribution, store approval, native feature parity, or live Stripe acceptance. Stripe provisioning and Apple/Google signing remain pending at the user's request.

## Files

The existing private storage and malware-scanning pipeline now supports:

- Immutable prior versions, optimistic publication, and idempotent publication requests. Upload a replacement into the same conversation/task, then publish against the current version. Prior object keys remain private and retained storage stays charged. A root supports 100 versions.
- Resumable uploads with server-authoritative offsets, fixed 1 MiB chunks, individual SHA-256 proofs, durable write intents, fenced leases, and final whole-file checksum/scanning. The web composer uses chunks for files larger than 1 MiB and retains failed reservations for retry. Explicit removal discards them. The existing 25 MiB maximum remains.
- Single byte-range downloads, suffix ranges, HEAD, strong versioned ETags, If-Range, and 416 responses. Local storage and S3 implement the same range interface.
- Version-pinned, expiring links with explicit workspace recipients, download counts, and revocation. The proof is stored as a hash; the one-time URL uses a fragment, cleared after authenticated resolution. Links do not grant access to the underlying conversation or task. Both creator and recipient must retain source access. Anonymous/public sharing is deliberately unsupported.
- Versioned workspace DLP policies and background reinspection. Downloads fail closed while required inspections are stale or blocked. Policy/file changes advance monotonic evidence revisions and invalidate retrieval contexts, file extractions, and derived file memories. Database source-visibility checks exclude stale/blocked inspections before hydration and model input, and OCR results are rechecked before persistence. Findings contain detector names/counts rather than matched secrets.

Data inspection currently covers supported UTF-8 text extensions up to 2 MiB, with private-key, AWS-key, Luhn-qualified card-number, and SSN detectors. Strict inspection blocks unsupported formats. This is not a general PDF/OCR/archive DLP engine. Malware scanning remains independent. Bucket migration, richer DLP engines, legal holds, and organization retention administration remain open.

Current access is checked again after object-store acquisition and before publication. As with an ordinary streamed download, revocation cannot retract bytes already delivered. A failed/partial shared download consumes its attempt. Chunk deletion intents are retained and retried so a stale object-store writer cannot leave an untracked object.

Use **Manage file** on an attachment for history, replacement uploads, and recipient links. **Settings → File protection** manages DLP and sharing policy. Hosted free plans cannot enable DLP; self-hosted organizations and eligible managed plans can.

## Billing

Each organization has one billing account shared across its workspaces. The default is self-hosted: plan allowances and seat caps are not imposed, but an explicitly configured hard spending budget is enforced. A once-only 14-day Team trial switches the account to managed allowances. Free/Team/Enterprise plan revisions define human-seat ceilings, quantities, and capability flags. These values are product configuration, not a published price list.

Human seats count distinct active, non-disabled human accounts with full membership across all organization workspaces. Guests, services, agents, duplicate memberships, and suspended people are excluded. Database admission locks the billing account before accepting a new managed seat. The Stripe quantity is reconciled against current seats; membership epochs prevent reused quantity idempotency keys after a seat-count reversal. An effective-dated seat-history/reporting product remains open.

Managed plans enforce model-token, tool-invocation, runtime-second, storage-byte, and participant-second allowances. Execution reserves organization capacity atomically before dispatch. Tool, storage, and call-participant transitions feed accounting through database triggers. Outstanding reservations remain held across period boundaries. Unknown outcomes are not assumed free.

The append-only ledger records signed quantity/cost deltas. Model costs use existing runtime receipts, with conservative reservation settlement when receipts are missing. Runtime is conservatively settled at its configured limit; media uses participant lease duration bounded to four hours per session. Long-session segmentation and provider-actual media receipts need qualification before commercial media billing. Tools, storage, runtime, and media currently carry quantity evidence with **unpriced** cost labels. They are not represented as proven zero-cost services. Forecasts and hard monetary caps cover known/reserved costs, not unknown provider charges. Embeddings, transcription, delivery/egress charges, provider-actual runtime, and complete provider rate-card qualification remain open.

Receipt corrections append adjustments instead of editing old usage. An operator with the migration/database-owner login can reconcile independently verified provider evidence:

```sh
BILLING_OPERATOR_DATABASE_URL='postgresql://<operator>@<host>/<database>' \
  node --import tsx scripts/reconcile-usage.ts /path/to/receipt.json
```

The JSON requires `id`, `workspaceId`, `category`, `reference`, `expectedVersion`, `units`, and `costMicros`. Quantities/costs are decimal strings; reconciliation versions begin at 1. Reusing a receipt ID with different contents fails. The customer-facing API cannot manufacture provider receipts. Keep the operator URL outside source control.

**Settings → Organizations → Plan & usage** exposes usage, seats, warning thresholds, budgets, trials, checkout/portal controls, plan-change previews, cancellation, invoices, and complete NDJSON exports. Exports paginate internally, recheck organization access per batch, and finish with an explicit completion record. They use a start-time cutoff, rather than claiming a database snapshot across the entire download. Reconciliation adjustments are recognized when posted; accounting-period restatement is separate work.

## Stripe adapter and operations

Stripe's SDK implements checkout, subscriptions, a customer portal, quantity updates, proration previews/confirmation, invoices, and period-end cancellation. No provider operations occur without configuration. Checkout return pages do not grant paid entitlements.

- `STRIPE_SECRET_KEY`: test key until independent test-account acceptance is complete.
- `STRIPE_WEBHOOK_SECRET`: signature verification key, required with a secret key.
- `STRIPE_TEAM_PRICE_ID` / `STRIPE_ENTERPRISE_PRICE_ID`: operator-configured recurring price IDs. Checkout requires active USD recurring prices. No placeholder checkout prices are created.
- `STRIPE_LIVE_ENABLED=true`: additional explicit guard before accepting a live secret key. Do not enable before release qualification.
- Register `<public-web-origin>/api/v1/billing/stripe/webhook` for subscription, invoice, and completed-checkout events.

Signed raw-body webhooks are durably acknowledged and deduplicated before canonical provider retrieval. Failed events back off and eventually remain in a failure queue. Database leases distribute periodic reconciliation, and account fencing prevents older reads from overwriting a newer synchronized entitlement state. Invoice storage is bound to the verified customer mapping.

Commands persist immutable provider payloads and request keys before external calls. A connection loss leaves an uncertain outcome; retry reuses the same Stripe idempotency key and payload. Other subscription mutations are blocked until it is reconciled. Requests older than 23 hours require operator investigation rather than assuming Stripe still retains the idempotency record. The settings UI reloads outstanding keys after navigation/reload. Failed webhook replay/operator dashboards, subscription refund/dispute operations, invoice-tax/local-currency qualification, live proration/credit handling, and replica/provider fault qualification remain pending.

Stripe provisioning was not performed. Local tests use the real SDK with a fixture HTTP transport and signed test webhook envelopes. A configured key, compiled code, or fixture success is not live-provider validation.

## Desktop

`apps/desktop` is an Electron client for the existing web application. It has no renderer IPC bridge, enables sandbox/context isolation, disables Node integration and webviews, pins the app origin, restricts external URLs, prompts for media/notification permission, and restricts downloads to the trusted origin. Screen capture fails closed until an OS picker is qualified.

```sh
npm run dev -w @ao/desktop
# Optional local server override, development builds only:
ORBIT_DESKTOP_ORIGIN=http://localhost:3000 npm run dev -w @ao/desktop
npm run test -w @ao/desktop
npm run build -w @ao/desktop
node --import tsx tests/runtime/desktop-smoke.ts
```

The desktop defaults to an in-memory session partition. Cookies and browser caches do not persist across app restarts. Existing encrypted web drafts/outbox can operate during the running session; durable native offline storage/background delivery is not implemented. Federated external-browser return/deep links and media/device parity still need implementation/acceptance. The local smoke test verifies actual Electron startup and renderer isolation, not signed package distribution.

For packaging, create ignored `apps/desktop/client.json` from `client.example.json`, using a real HTTPS origin, HTTPS update origin, and Ed25519 public key. Run `npm run release -w @ao/desktop` only when signing/notarization credentials are ready. The release command requires signing inputs and never publishes automatically. Windows also requires `ORBIT_WINDOWS_PUBLISHER`. macOS requires the Apple API signing/notarization inputs listed by the release script. No keys or generated signing assets belong in the repository.

Updates require a signed, expiring manifest for the current platform/architecture, a newer stable semantic version, exact artifact URL/hash agreement, user consent, and the updater's OS publisher signature verification. Downgrades, unsigned manifests, mismatched artifacts, and development-build update installation fail closed. Linux updates are disabled pending a distribution-specific mechanism. Signed-update acceptance must be run with real signed builds on each OS.

After building a signed artifact, the operator can generate the detached release manifest without publishing:

```sh
ORBIT_RELEASE_KEY_FILE=/secure/path/release-key.pem \
  node apps/desktop/scripts/sign-update.mjs \
  /path/Orbit.zip 1.0.1 darwin arm64 \
  https://releases.example.com/darwin/arm64/ /path/to/feed
```

Serve `release.json`, `release.json.sig`, the corresponding electron-builder feed metadata, and the artifact from the pinned release origin. Alternatively put the detached signature in `X-Orbit-Signature`. macOS/Windows feeds need separate matching artifacts; do not reuse an unrelated release's signature. Manifest expiry requires publishing a newly signed manifest when an unchanged release remains offered beyond its validity window.

## iOS and Android

`apps/mobile` contains an Expo/React Native WebView client for the same trusted workspace. Configure `EXPO_PUBLIC_ORBIT_ORIGIN` to a real HTTPS app origin before building; the example domain is intentionally unusable. Navigation is origin-restricted; external HTTPS links open outside the app. Arbitrary native messaging, third-party cookies, file URL access, cleartext mixed content, disk caching, and unsigned OTA updates are disabled. The app uses a private session, safe-area layout, system theme, a back handler, retry UI, and permission prompts.

```sh
npm run dev -w @ao/mobile
npm run build -w @ao/mobile  # verifies configuration; this is not a native binary build
npm run ios -w @ao/mobile   # requires full Xcode
npm run android -w @ao/mobile # requires Android SDK/JDK
# Compile both platform JavaScript bundles locally:
cd apps/mobile
npx expo export --platform ios --platform android --output-dir ../../.data/mobile-export
```

Both JavaScript bundles were compiled locally. Full Xcode and a Java runtime/Android SDK are unavailable on this host; native compilation, signing, store submission, and physical-device acceptance remain pending. Native push registration, external-browser SSO callbacks, downloads/file-picker behavior, mobile screen sharing, durable OS-protected caches, background/offline synchronization, and complete cross-client parity are still open. The hosted web UI is shared; that is not evidence that all native platform capabilities work.

The Expo development CLI currently brings `node-forge`/Zod 3 security advisories through its build-tool dependency tree. No compatible upstream fix was available in the inspected package versions; forced downgrade/major overrides were not applied. Do not expose its development server/tunnels to untrusted users. Resolve/requalify that build-tool chain before native release. The mobile bundle does not include the CLI and OTA updates are disabled; this does not turn an advisory into a passing security assessment.

## Accessibility, localization, and onboarding

New file dialogs use the established Radix focus management, accessible form labels, keyboard dismissal, and reduced-motion handling. Axe checks cover the new billing/onboarding regions and the file dialog; broad screen-reader, keyboard, zoom, touch, contrast, and native-device qualification remain open.

The getting-started checklist persists per signed-in account with optimistic concurrency. Its stable translation keys cover English, Spanish, Hindi, French, German, and Japanese (English variants fall back to English), using the existing account locale. The rest of the product is not fully translated. The checklist is user-marked; a guided team/agent demonstration and provider-health onboarding remain open.

## Local verification and CI

The API suites exercise tenant isolation, chunk integrity/replay, immutable versions/quota, DLP fail-closed behavior, share recipients/limits/revocation, billing budgets and receipts, uncertain outcomes, signed SDK webhooks, entitlements, and account-scoped onboarding. PostgreSQL verification uses disposable databases. Browser suites exercise real UI/API/storage flows and accessibility checks. CI runs native policy/configuration/bundle checks without signing, and continues existing PostgreSQL/browser regression jobs.

No Stripe account was provisioned, no live payment was made, no signed release was produced, and no app-store application was submitted.
