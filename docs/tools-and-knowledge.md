# Tools, secure execution and governed knowledge

Implemented in migrations 040–048. The existing transactional execution worker, exact approvals, identity policies and forced tenant RLS remain the control plane. Provider actions run in a separate worker; collaborative documents and knowledge governance are stored in PostgreSQL or the embedded development database.

## Tool registry and approval policies

`GET /v1/execution/tools` exposes eight versioned tools: `create_task`, `save_knowledge`, `delegate_agent`, `read_tasks`, `read_knowledge`, `connection_action`, `execute_code`, and `interactive_form`. Each definition declares its resource scope, permission, effect, result bound, deadline and cost category. Agent revisions grant individual tools. Existing agent grants remain unchanged. Read tools return bounded, inspectable results from the source conversation; they do not give the managed model an unrestricted database interface.

The workspace policy classifies effects as read, write, publish, deploy, access, payment, destructive, export or execute. Administrators configure administrator review, owner review or denial, an independent-reviewer requirement, and approval validity of 1–1,440 minutes. There is no automatic approval mode. The configuration is versioned and updated with optimistic concurrency through `/v1/execution/tool-policy`.

A proposal captures its tool version, policy version and authorization preview. The SHA-256 action digest covers the exact parameters and preview, including the provider account name, endpoint, operation description and connection version. Decisions and execution recheck the original requester, agent, conversation, current grants, reviewer authority, account verification and policy. Approval does not lend the reviewer’s resource permissions to the requester or agent. Policy, grant or credential changes fence an existing proposal rather than silently changing its meaning.

## Owned provider connections

Connections use a small, explicit adapter protocol. They are not arbitrary authenticated HTTP clients. The connection owner registers named operations and their effects; an agent cannot choose a different endpoint, credential, method or effect. Only an active, verified human member with execution permission can manage their connection. Secrets are encrypted with authenticated encryption and connection-specific associated data.

The owner grants operations separately to the requester and agent, with expiry within 90 days. Owning the connection does not implicitly grant an invocation. Every dispatch rechecks both grants and the current owner. Rotation, revocation and grant changes advance the connection version and invalidate captured proposals. Removing the owner or the relevant member permissions prevents new dispatches. In-flight provider operations may already have taken effect; revocation cannot undo them.

Configure `TOOL_PROVIDER_HOSTS` with exact public HTTPS hostnames and configure `IDENTITY_ENCRYPTION_KEY` (or the existing encryption-key fallback). Registration and every provider request resolve the host again, reject private/special IPv4 and IPv6 addresses, and pin a validated address to the connection. User information, query strings, fragments, custom ports and redirects are denied. These checks share the webhook endpoint validator. A provider endpoint outside the allowlist is unavailable by default.

For an endpoint such as `https://adapter.example.com/orbit`, the adapter implements:

- `POST /orbit/actions/{idempotency-key}` with `{ "operation": "registered_name", "payload": { ... } }`.
- `GET /orbit/actions/{idempotency-key}` to look up the durable outcome without executing the operation.
- Both receive the same `Idempotency-Key` and an owner-managed bearer credential.
- HTTP 200 returns exactly `{ "status": "succeeded", "receipt": "opaque receipt" }`, `{ "status": "not_applied", "receipt": "durable proof" }`, or `{ "status": "unknown" }`.

The adapter must persist the idempotency key before its side effect, reject a different intent under the same key, and provide durable receipt lookup. These are provider integration requirements that must be qualified for each real adapter. The generic protocol does not assert that an arbitrary service provides exactly-once execution. Responses are bounded to 4 KiB and calls to 15 seconds; raw headers and provider bodies are never published as tool output.

## Action ledger, capabilities and recovery

After an approved external action passes current authorization, the gateway issues an encrypted, 60-second capability bound to the workspace, run, invocation, digest, expiry and random nonce. Only its encrypted representation and hash are stored. No execution capability or provider credential is handed to the model, form or browser.

The tool worker atomically verifies and consumes the capability under the workspace/run/action locks, records dispatch, then releases the transaction before contacting the provider or sandbox. Competing replicas cannot submit the same prepared action twice. The durable ledger states are prepared, dispatched, succeeded, failed and outcome_unknown. Stable idempotency keys and append-only events preserve intent and outcome evidence.

An interrupted dispatch is never reclaimed for another POST. A lost response or expired dispatch lease becomes uncertain. Recovery uses only the provider’s GET receipt endpoint. A not-applied result is terminal for that invocation; it does not automatically replay it. Any new attempt requires a new reviewed action. A workspace owner can attest a confirmed uncertain result with a receipt and explicit evidence through `/v1/execution/actions/:invocationId/reconcile`; the actor and evidence are retained. This also supports sandbox outcomes that cannot be recovered from the provider. The UI exposes the ledger and this owner-only reconciliation form.

The worker bounds concurrent external jobs to four per process and rotates tenant ordering. It drains on shutdown. These controls complement, rather than replace, operator-wide provider concurrency, sandbox spending and egress limits.

## Isolated programs and structured interactive forms

`execute_code` supports JavaScript, Python, shell and SQLite. It uses `@vercel/sandbox` 3.6.1 with a disposable microVM, deny-all networking, one vCPU/2 GiB memory, no exposed ports, no mounted host files, and no application environment or database credentials. Program deadlines are 1–30 seconds; VM lifetime includes a five-second cleanup allowance. Output is streamed into a 24 KiB combined bound and the sandbox is stopped in `finally`, including when command observation fails.

SQLite runs against a fresh in-memory database inside that VM. File attachment, pragma execution and native extension loading are denied; query results are bounded to 100 rows. This is a SQL workbench, not a connection to Orbit’s database or a customer’s production database. External database integrations must use separately qualified owned adapters and constrained provider identities.

Live execution defaults off. Set `TOOL_SANDBOX_ENABLED=true` only after configuring sandbox authentication, regional placement and provider spending limits. On Vercel use the deployment OIDC identity; local operators can provide `VERCEL_OIDC_TOKEN`. Outside that environment, all of `TOOL_SANDBOX_TOKEN`, `TOOL_SANDBOX_TEAM_ID`, and `TOOL_SANDBOX_PROJECT_ID` are supported. These authenticate the host SDK and are not injected into the VM. No paid sandbox execution was performed during implementation verification.

`interactive_form` publishes a bounded schema of text, number and boolean fields. It accepts neither supplied HTML nor JavaScript. The browser renders escaped controls in an iframe with an opaque origin (`sandbox="allow-scripts"`, without same-origin or form permissions), a restrictive CSP, and no network access. A nonce- and source-window-checked message bridge returns values for review. The parent submits reviewed values through the normal authenticated API; the server rechecks the current audience, expiry, field types and retry identity and records an audit event. Native iframe form submission is deliberately unavailable. This supports structured interactive mini-apps; arbitrary executable customer mini-app bundles and a separately hosted app marketplace remain outside this implementation.

## Collaborative knowledge authoring

Pages render safe Markdown rich text and provide formatting controls and preview. **Edit together** opens a Yjs document containing shared title and body text. Authorized synchronization runs over HTTP every 1.2 seconds, merges concurrent changes under a page lock, and records each changed published batch as an attributed immutable version. Clients preserve relative cursor positions, retry merged state safely, and abort requests and clear content after revocation. No browser document state is stored offline.

Document state is bounded to 250 KiB, title to 200 characters and content to 50,000 characters. Publication and CRDT state commit together. Ordinary whole-page editing, restore and accepted synthesis reset the document generation; old editors must review the replacement rather than merge into it automatically. Long CRDT histories can be compacted by publishing a reviewed whole-page version. The original conflict-review and lost-save retry flows remain available.

This transport is intentionally database-backed and works across API replicas without an in-memory document authority. High-fanout editing, broker-based synchronization and deployment load/failover qualification remain operator work; these tests do not claim that such loads were measured.

## Ownership, reviews and canonical context

Each page has a human owner, optional reviewers, freshness date, supersession link and a category: page, dictionary, decision, procedure, project_context, summary or journal. New-page creation selects the category. Metadata changes use a captured version. Ownership transfer disables the previous synthesis schedule until the new owner configures it. The API permits a currently authorized administrator to recover ownership after an owner becomes inactive, without bypassing the page audience or source history.

Review decisions carry evidence and bind to both the page version and a review epoch. Changes to ownership, reviewers or citations invalidate the epoch even when the page text is unchanged. Every assigned reviewer’s latest decision for the current context must approve before the page becomes approved. Contradictions and changes requested are explicit states. Expired freshness must be renewed before approval. Discussion comments support quoted anchors, attributed retry-safe creation and author/owner resolution. Comment and review histories have reader- and page-bound cursor pagination.

Provenance links identify exact page or message revisions and retain the same conversation audience, including workspace-only pages. Cycles are rejected. An append-only provenance journal preserves links and removals across corrections. Database-enforced lineage checks also honor join-time access: a newly published summary cannot expose a source from before a participant joined. Historical page revisions traverse their historical citations and retain their original restrictions. An owner may inspect their page for correction, but source use, new ownership/reviewer assignments and exports require current source access.

Source edits mark derived pages stale transitively. Source archival/deletion and contradictions block derived content from automated retrieval and export. Freshness expiration and supersession also trigger review. Search filters canonical availability, and hosted knowledge reads independently check both the requester and agent’s complete source history. Corrections publish a new version, replace citations explicitly and return the page to review; they never rewrite older published versions. Retention cleanup cannot remove the access restrictions of historical derived revisions.

## Scheduled synthesis and governed lifecycle

Owners can schedule daily-to-yearly extractive source digests over up to twenty visible pages in the same audience. The worker checks the owner’s current verified identity, permissions, source lineage and ownership each time. It produces a cited proposal rather than overwriting the canonical page. This implementation uses deterministic excerpts, not an unconfigured model pretending to synthesize research.

Human edits make an older proposal fail its base-version check. Source correction, deletion or contradiction invalidates pending proposals. Acceptance rechecks every cited revision and records a fresh page version and provenance; rejection preserves the existing page. There is at most one pending proposal per page.

Archival and restoration are version-checked owner actions. Export requires a current, active, approved, unsuperseded page with available, fresh citations and current source access. JSON exports contain the current page, governance, exact citations, review evidence and provenance. Review/provenance history bounds are explicit through `omittedHistory`; the paginated APIs remain available for inspection.

Deletion requires the owner, a captured page version and a reason. It immediately removes normal page access, disables synthesis, invalidates proposals and propagates source invalidation. Workspace owners configure retention of 7–3,650 days and legal holds. A narrowly granted, tenant-bound SECURITY DEFINER function physically erases eligible deleted pages, collaborative state, comments, reviews and immutable revisions after retention. Normal writers cannot mutate revisions or provenance. Backup retention and already-downloaded exports are separate operator responsibilities; a database deletion cannot recall an exported file.

## Verification and operating boundaries

Coverage includes concurrent CRDT merges, duplicate updates, generation resets, source ACLs, current and historical lineage, private join-time restrictions, ownership, all-reviewer approval, comment pagination, provenance immutability, transitive invalidation, synthesis fencing, legal holds and physical erasure. Tool coverage includes grant and policy revocation, exact previews, competing dispatchers, lost-response lookup, sealed capability expiry, operator reconciliation, scoped reads, structured-form validation, bounded sandbox output and cleanup.

The production browser flows exercise two simultaneous editors, safe rich-text rendering, attributed history, governance, provenance, discussion, tool policies and the isolated form review/submission bridge. Existing full browser regression remains in CI; API suites run against both the embedded database and PostgreSQL 17. Sandbox tests qualify the SDK boundary using fixtures, not a live paid VM.

Organization-level tool-policy inheritance, product-specific provider/MCP adapters, private-network connectors, separately hosted arbitrary mini-app code, customer database identities, file-source provenance and propagation into external search/vector stores remain explicit integration work. Workspace policies, owned adapter dispatch, isolated scratch execution and canonical page/message lineage are implemented here.

Local verification on 2026-10-25: 293/293 PostgreSQL tests; 289 embedded tests passed with four PostgreSQL-only checks skipped; 53/53 full production-browser flows and 8/8 subsequent knowledge/browser checks; production web and managed-runtime builds, typecheck, formatting and production dependency audit passed. The local store was migrated through schema 48 with historical row counts preserved and all eighteen new tenant tables verified under forced RLS. Live provider and sandbox qualification and remote CI execution are not claimed.
