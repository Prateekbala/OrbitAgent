# Organization erasure and isolated customer model keys

Implemented by migrations 075–076. This increment removes the previously reported Expo advisory chain and adds executable organization-deletion and BYOK protocols. It does not provision production services or establish independent provider/operational/legal acceptance.

## Dependency remediation

The resolved Forge version is 1.4.1; Expo CLI alone is overridden to Zod 4.6.7. Expo remains on SDK 58.0.19 with CLI 58.1.15. No advisory is suppressed, and no SDK downgrade is used. npm 12.2.1 is pinned in `packageManager`, CI and container builds; npm 11 incorrectly reports the reviewed overridden dependency edge as invalid. Use the pinned manager when installing or inspecting this tree.

`npm run ops:test` exercises Expo's actual plugin/output/MCP schema consumers and its certificate signing helpers. It includes a negative RSA DigestInfo regression. Both iOS and Android JavaScript bundles are compiled locally without signing/publishing. The root advisory gate reports zero vulnerabilities. Native store distribution and physical-device acceptance remain separate requirements.

## Organization deletion

Owners use **Settings → Model keys & organization deletion** or `POST /v1/organizations/:org/erasure`. The request requires an exact organization-name confirmation, a recorded reason, an idempotency key, and either the current password or an organization-bound SSO login completed within five minutes. Existing organization MFA/SSO/domain/session policies still apply. Administrators and guests cannot request deletion.

The transaction locks organization/workspace authority, increments the authorization version, revokes support and SCIM access, destroys stored customer model-key envelopes, revokes shared-channel grants, and records an immutable audit event. Forced restrictive RLS immediately hides existing workspace data from runtime and ordinary worker roles. Configuration-write guards prevent workspace/key/identity re-creation after deletion starts. Frozen workspaces are excluded from new password-login selection; account-session access to the deletion status remains available to the owner.

`GET /v1/organizations/:org/erasure` exposes only progress metadata. `/organizations/:organizationId/erasure` provides a standalone owner page which does not bootstrap the deleted workspace. A request cannot be cancelled from the UI. Legal holds pause physical deletion while the organization remains frozen.

The isolated `ao_erasure` worker is the only service allowed to execute the fenced purge protocol. The ordinary API/worker logins must not be granted this role. Startup rejects owner/superuser/BYPASSRLS logins, inherited privileges and mixed application/service roles. Erasure functions require an active matching lease and inspect preservation again under organization/workspace locks. Spoofing a GUC from an ordinary role does not authorize history deletion.

The worker:

1. Checks all workspace/conversation legal holds and the earlier knowledge-preservation flag.
2. Allows a three-minute quiescence period for previously admitted uploads, then persists an inventory of file versions/chunks/previews, recordings, active rooms and runtime sessions.
3. Stops active media rooms/recordings when the media adapter is configured. It deletes file/recording items in bounded batches with durable per-item acknowledgements and renewable leases.
4. Removes the whole workspace object prefix, including S3 object versions, delete markers and unfinished multipart uploads. Locked versions and provider errors stop progress. Each returned key is checked against the exact workspace prefix. Local erasure recursively removes only the validated workspace directory.
5. Removes tenant-bearing source and derivative rows, including messages, files, tasks, comments, knowledge/CRDT/history, drafts, retained transcripts, retrieval contexts/indexes/memories, runtime checkpoints/traces, tool events, connector secrets, workflow/automation state and device payloads. It breaks eligible nullable references and deletes in dependency order. An unresolved constraint rolls back the database purge and leaves the organization frozen.
6. Removes organization identity configuration, domains, grants and model keys; revokes retained SCIM credential tombstones; redacts organization/workspace/member display fields. Cross-organization content remains owned by its host, while participation is revoked.
7. Waits for independently signed runtime, provider and backup-expiry receipts before declaring completion. The backup receipt cannot precede the request's captured expiry boundary. Storage/database completion alone is insufficient.

Global accounts belong to people who may still use other organizations; they are not deleted by an organization owner. Minimal organization/workspace/member identifiers, account-session access for the requesting owner, cryptographically intact audit metadata and financial accounting records are retained. These exclusions are explicit and require an approved retention/legal basis. Account-level erasure remains a separate R19 item. Previously downloaded exports and customer-controlled device copies cannot be recalled by deleting server records; their handling must be included in the operator's deletion assessment.

The database purge discovers workspace-bearing stores rather than silently ignoring new ones. Migration 075 explicitly preserves normal immutable-record guards while adding a narrowly fenced erasure exception. Future schema/trigger changes must maintain both this exception and the organization RLS fence; unknown dependencies fail closed. The current database phase is transactional, so large-organization duration, vacuum/WAL/PITR behavior and realistic storage/media scale still require operational qualification.

## External deletion evidence

`ingest-deletion-receipt.ts` accepts the existing per-source format and a new organization envelope:

```json
{
  "id": "operator-receipt-id",
  "scope": "organization",
  "jobId": "<uuid>",
  "processor": "runtime",
  "evidenceHash": "<sha256>",
  "completedAt": "<ISO timestamp>"
}
```

The detached signature covers the exact bytes using an operator-trusted Ed25519 key. Processor values are `runtime`, `provider`, and `backup`. Evidence must cover actual retained stores, provider subscriptions/exports, processing logs, replicas and non-applicable components; creating a signature does not prove discovery or deletion. Receipt replay is idempotent, conflicting evidence is rejected, and accepted evidence wakes the job. There is no customer endpoint to self-approve physical deletion.

A stopped or failed component leaves a held/dead/waiting job and a frozen organization. An operator must correct configuration/permissions, inspect the fenced job and requeue an expired dead job through the isolated operational database with a recorded incident/change. Missing media configuration, legacy storage providers and object locks cannot be bypassed by the API. Backups, restored tombstone journals, external provider acceptance and realistic failover remain R20 operational requirements; no automatic production deletion proof is fabricated.

## BYOK architecture

OpenAI customer keys are currently supported. The owner grants explicit model identifiers and an expiry of at most one year. The API stores only an envelope: a random AES-256-GCM data key wrapped by a dedicated RSA-OAEP-SHA256 public key (at least 3072 bits). Authenticated data binds organization ID, credential ID and generation. The API/ordinary worker have no wrapping private key. API lists, audits, events, prompts and checkpoints never return the key envelope or plaintext key.

Every run pins its selected credential ID/generation at database admission. The pin is immutable. Required-BYOK policy rejects admission when an active allowed model key is unavailable. Revocation, expiry, rotation, organization deletion, policy changes and source-access changes fence execution. A pinned run never silently falls back to an operator key. Optional policy may select a platform runtime only for a newly admitted run without a customer-key pin.

The ordinary execution worker signs a 60-second Ed25519 capability naming the exact workspace/run/key/generation and broker audience. It sends the bounded request to a separate TLS model broker. The capability is a transport credential and is not placed in model context. The broker has only `ao_model_broker`, its private wrapping keys and the public capability-verification key. It cannot assume identity, runtime, erasure or table-owner roles.

The broker validates current source audience and run authority before unwrapping, immediately before provider dispatch, while the provider request is active, and before storing/publication. It checks current account/agent status, policy/auth/revision/epoch, organization state, key generation/expiry and pinned model. The fixed destination is `https://api.openai.com/v1`; neither the model nor a client can select an endpoint. Redirects are refused. The real AI SDK provider adapter bounds serialized request/schema bytes and output tokens, disables automatic retries and telemetry, and receives the plaintext key only as the provider authorization header.

`byok_runs` is an atomic provider-action ledger. Replayed identical completed requests return the saved result; changed inputs or dispatched/uncertain requests never initiate another provider call. A crash/ambiguous provider response requires reconciliation. Errors crossing the broker boundary are fixed codes/messages; raw SDK errors, authorization headers and credentials are not returned or logged. A completed saved result can be reconciled by the existing API under current access checks without giving the API a signing/private wrapping key. Revocation monitoring aborts active calls cooperatively; it cannot prove that a provider stopped computation already accepted.

Customer-key model calls currently support a single bounded invocation of at most 300 seconds. They retain the normal proposal/approval/tool publication path; they do not enable model-selected tools. Missing cost receipts use the existing conservative reservation accounting. Usage estimates are not a claim that the platform billed the customer's provider account correctly. Other providers, independent live-model acceptance and recovery/load qualification remain pending.

## Deployment

Use `deploy/compose.production.yaml` plus the explicit `deploy/compose.enterprise.yaml` overlay. The overlay adds separate broker/erasure services and mounts only the credentials each requires. The model broker requires a dedicated TLS key/certificate; its certificate must contain the private service hostname, and the worker uses the issuing CA through `NODE_EXTRA_CA_CERTS`. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Prepare separate NOINHERIT database logins. Grant only `ao_model_broker` to the model-broker login and only `ao_erasure` to the erasure login. Keep the existing four application roles on API/ordinary-worker logins, with neither isolated role. Assign passwords interactively or through the deployment secret manager; never commit them. Apply migrations with the separate privileged migration owner first.

The API receives `BYOK_WRAPPING_PUBLIC_KEY_FILE`. The execution worker additionally receives `BYOK_CAPABILITY_SIGNING_KEY_FILE` and `MODEL_BROKER_URL`. The broker receives `MODEL_BROKER_DATABASE_URL`, `BYOK_CAPABILITY_VERIFY_KEY_FILE`, `BYOK_WRAPPING_PRIVATE_KEY_FILES` (JSON paths, at most eight), and TLS key/cert files. Keep previous wrapping keys decrypt-only until every retained envelope has been rotated by its owner; retirement requires an inventory and backup/key-custody review. Customer key rotation is version-checked and invalidates old run bindings.

The erasure service receives only `ERASURE_DATABASE_URL` and separately qualified storage/media access. If recordings exist, add the actual shared retained-recording volume and LiveKit credentials to that service; the base overlay deliberately does not invent an empty replacement volume. Legacy storage/provider copies must be made available to a matching deletion component or resolved by an audited operator workflow. Local tests use synthetic keys/accounts and do not validate these production services.

## Local acceptance recorded on 2026-10-27

The full API suite passes 491 tests (four PostgreSQL-only checks are skipped in the embedded run). The full Chromium suite passes 83 tests, with two live-media cases skipped while those services are stopped. New UI flows pass automated accessibility checks. The PostgreSQL 17 recovery drill passes 32 targeted checks through all 76 migrations, restores synthetic application content and rejects altered ciphertext. The actual SDK adapter is exercised through a synthetic HTTP response, and a queued execution crosses the isolated local broker without touching the platform runtime. These checks use no live OpenAI account or provider credential.

Root npm audit reports zero vulnerabilities. Both mobile JavaScript bundles, Expo schema/signing regressions, type checks, generated API compatibility, formatting and production image builds pass. Production PKI, IAM/storage/media acceptance, provider subscriptions/deletion, independent receipts and live OpenAI qualification remain deployment-specific work. The broker currently supports OpenAI only; this is not a claim of universal provider coverage or completion of every R19/R20 item.
