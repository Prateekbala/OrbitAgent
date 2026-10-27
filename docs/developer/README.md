# Orbit developer platform — API v1

The public boundary is an explicit operation registry in `apps/api/src/developer/operations.ts`. REST, first-party MCP, token authorization, OpenAPI, generated TypeScript types, and Python operation maps use this registry. Internal `/v1` endpoints are browser application interfaces and do not acquire public compatibility guarantees by appearing in the source tree.

## Interfaces

With the default web server:

- REST: `http://localhost:3000/api/public/v1`.
- OpenAPI 3.1.1: `/api/public/v1/openapi.json`; a generated copy is `docs/developer/openapi.json`.
- MCP: `/api/mcp`, stateless Streamable HTTP, official TypeScript SDK v2.4.0; current 2026-07-28 and legacy 2025-11-25 protocol exchanges are tested.
- Realtime: `GET /api/public/v1/events` for reconnectable batches, `GET /api/public/v1/events/stream` for SSE. Send `Authorization: Bearer …`; never put credentials in URLs. SSE requires `events.read`, emits change/checkpoint/heartbeat frames, has bounded connections and a five-minute lifetime, and rechecks credentials between batches. Public streams omit member presence snapshots.
- OAuth metadata: `/.well-known/oauth-authorization-server/api` and `/.well-known/oauth-protected-resource/api/mcp`. Explicit `/api/.well-known/…` compatibility URLs are also served. Reverse proxies must preserve the configured HTTPS `WEB_ORIGIN` and well-known rewrites.
- Signed webhook subscriptions and delivery history are managed under Developer in the application. Native incoming provider webhooks and signed connector event ingress retain the connector-specific contracts described in `docs/retrieval-and-connections.md`.

API v1 exposes task listing/detail/create/edit/transitions/comments; message history/send/edit/delete; knowledge read/create/versioned edit; project reports; access-filtered search; hosted run start/status/cancel; paused automation creation/revision/control/read; and events. Every supported request shape and response is in OpenAPI. New browser endpoints are not automatically exported. Files, organization administration, credential creation, approval decisions, and ownership consent do not become callable by a public key.

## Authority and scopes

Create keys in Developer. A key contains an explicit set of scopes, conversation grants, optional workspace resources, permitted REST/MCP interfaces, and a lifetime of 1–365 days. Workspace resources means content without a conversation; it does not mean every channel. Secrets are returned once, stored only as hashes, and omitted from lists, audit records, errors and traces. Rotation immediately invalidates the previous key and preserves its expiry and grants.

A credential attenuates its current verified human owner. Membership suspension, account disablement/auth-version changes, organization policy changes, domain restrictions, expiry, revocation and OAuth client revocation invalidate it. Database policies restrict conversations and their content even if a query omits an audience predicate. Pagination/event cursors are bound to the credential as well as the member. Public API keys cannot resume an automation: its owner reviews and resumes in the browser.

Starting a hosted run requires `execution.manage` and an explicitly granted source conversation. Its credential origin is retained. Execution and delegated work revalidate that origin before model/tool work and publication; revoking a key does not grant a queued run perpetual authority. Agent configuration, workspace budget reservations, connection-owner grants and human approval requirements still apply. API keys do not approve proposals.

Existing service accounts remain a separately governed organization capability. Developer keys and OAuth grants deliberately use an explicit human acting identity; there is no implicit service-to-owner impersonation.

Browser applications must have their exact HTTPS origin configured in `PUBLIC_API_ORIGINS`. CORS applies only to bearer/proof-authenticated public interfaces and does not enable cross-origin cookies or consent/credential-management requests.

## OAuth application flow

Register an application in Developer with exact HTTPS redirect URIs. Loopback HTTP uses literal `127.0.0.1` or `[::1]` and an exact registered URI. Public clients use `token_endpoint_auth_method=none`. Dynamic client registration, implicit grants and password grants are not offered.

1. Generate a cryptographically random PKCE verifier (43–128 permitted characters), its SHA-256 base64url challenge, and an unpredictable state value.
2. Open `/developer/authorize` with `response_type=code`, `client_id`, exact `redirect_uri`, `code_challenge_method=S256`, `code_challenge`, `scope` (space-separated), `state`, and `resource`.
3. `resource` is exactly `${WEB_ORIGIN}/api/public/v1` or `${WEB_ORIGIN}/api/mcp`. The consent page identifies the account/application, allows an explicit workspace switch, and requests selected scopes and conversations. Switching uses normal organization MFA/SSO checks. Review and consent are browser-only.
4. Verify returned state and `iss`. Exchange the one-use, five-minute code at `/api/oauth/token` with the original verifier, client ID, redirect URI and resource. JSON and URL-encoded forms are accepted; duplicate form fields are rejected.
5. Access tokens last at most an hour and are restricted to the chosen resource. Refresh tokens rotate on every use and retain the original 30-day expiry. Reusing an already consumed refresh token commits revocation of its entire family before returning `invalid_grant`.
6. Revoke either token at `/api/oauth/revoke` with its `client_id`. Unknown tokens have the same successful response. Revocation is also available in Developer settings.

OAuth token errors use the standard `error`/`error_description` envelope; public REST errors use `{error:{code,message,requestId}}`. Treat credentials as opaque. Do not serialize them into model prompts, tool parameters, event payloads, logs, or frontend persistence.

## Clients and compatibility

TypeScript client: `packages/sdk/src/index.ts`; Python 3.11+ client: `packages/sdk/python/orbit_sdk`. Both reject external HTTP bases, refuse redirects, accept a secret supplier, preserve structured errors and perform no implicit write retries. Examples are in `examples/developer`.

```ts
const client = new OrbitClient('https://workspace.example/api/public/v1', () => secret);
const result = await client.request('createTask', {
  body: {clientId: durableRequestId, title: 'Review release', conversationId},
});
```

Persist `clientId`/`requestKey` before a write and reuse it after losing a response. Versioned edits require the latest resource version; do not blindly retry conflicts. Cancellation fences publication; it is not evidence that an external action did not happen. `outcome_unknown` requires reconciliation before replay.

Run `npm run api:generate` after registry changes. `npm run api:check`, `npm run typecheck`, API contract tests and `npm run test:sdk:python` run in CI. The generated TypeScript response types come from OpenAPI; Python's operation map comes from the same definitions. These packages are local source packages and have not been published to a registry.

API v1 changes are additive. Existing meanings, required fields, scope semantics and response field types must not change incompatibly within v1. A breaking change needs a separate public version and migration documentation. Optional new fields and new enum values should be handled defensively by clients. Deprecations must identify a replacement and an announced removal window; no removal window is currently active.

## Webhooks

An owner chooses event types and conversations. The server rechecks account authority, current audience/history, source existence, subscription version and the delivery lease before dispatch. Payloads contain an event identifier, type, resource identifier and conversation identifier, without message/file bodies. Fetch current content through an independently scoped credential.

Verify HMAC-SHA256 over `webhook-id + '.' + webhook-timestamp + '.' + original_body` using the one-time signing secret; `webhook-signature` is `v1=<hex>`. Reject timestamps outside a short replay window and atomically deduplicate the stable webhook ID. A verifier example is `examples/developer/verify-webhook.py`.

Deliveries use expiring claims, eight bounded attempts, exponential backoff, a dead-letter history, and explicit replay. At-least-once delivery means duplicate signals are possible. Pause and signing-key rotation fence pending generations. Resume starts at current events, without silently forwarding events collected while paused. URLs must be HTTPS, on `DEVELOPER_WEBHOOK_HOSTS`, resolve only to public addresses, and cannot redirect; validated DNS is pinned during the connection.

## Remote MCP connections and connector authoring

See [connector and MCP authoring](connectors.md). Live provider qualification remains an operator task using independent test accounts; local credentials or a successful discovery request are not proof of full provider coverage.
