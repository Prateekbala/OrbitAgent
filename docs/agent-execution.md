# Agent control and coordinated execution

Orbit now provides persistent agent configuration, scoped external receiving, hosted admission and recovery, and approval-gated delegation. Open **Agents → Agent controls** for configuration, credentials, delivery history, ownership and archival. Open **Agent runs → Execution limits and spending** for workspace policy, or **Run details and coordination** for checkpoints, exports, delegation and verification.

## Versioned configuration and lifecycle

Each agent has an immutable, numbered configuration revision. A revision contains instructions, an operator-approved model selection, local tool grants, reviewed skill grants, activation mode, conversation restrictions, and execution limits. Revision 1 is backfilled for existing agents. Publishing an edit requires the displayed agent version and fences queued, running, approval-waiting and uncertain work from the preceding revision. Old runs retain their captured configuration; they cannot publish or apply tools under a superseded revision.

Activation can allow explicit mentions and manual requests, manual requests alone, or no execution. An empty conversation selection means all conversations the agent independently has access to. A selection narrows activation; it never grants membership or past private history. Instructions and configuration are workspace agent metadata, not a private secret store.

The current reviewed skills are planning, research and verification. They load code-versioned procedures into the effective instructions. They do not confer tool authority. Hosted tool grants are `create_task`, `save_knowledge` and `delegate_agent`; every mutation still needs a current human administrator's exact, expiring approval. External receivers separately operate under their bearer credential's API scopes.

Ownership transfers and archival preserve attribution and history, fence active work, revoke old credentials and disable the previous webhook destination. A transfer starts paused. Restore an archived agent deliberately, then issue new credentials or reactivate hosted execution. Workspace administrators manage lifecycle and configuration; assigning an owner does not grant that person administrator privileges.

Health views distinguish configured runtime capabilities from observed receiver contact, show open runs and inbox backlog, and expose dead letters. A configured URL is not proof that a remote service is healthy. `last_seen_at` records authenticated external polling or successful hosted session contact. No live-model health or deployment durability is inferred from configuration alone.

## Credentials and external receiving

Credentials contain 256 random bits and are shown once. Only hashes are stored. Issue named, independent credentials with explicit scopes, optional conversation restrictions, and expiry from one to ninety days (default thirty). List history, inspect recent use, revoke one credential, or rotate all credentials. Rotation pauses the agent and fences old leases. An ordinary rotation preserves the most recent credential's scopes, conversation restrictions and configured lifetime; it does not silently issue a broader replacement. Offboarding revokes credentials created by the departing member as well as credentials belonging to their affected agents.

Available scopes are `inbox.read`, `inbox.work`, `messages.read`, `messages.write`, `tasks.read`, `tasks.write`, `knowledge.read`, `files.read` and `search.read`. Search grants aggregate searchable-content access within the credential's resource audience. Administrative and human-only APIs are unavailable to these credentials. PostgreSQL restrictive policies enforce conversation restrictions on content and event reads/writes, including streaming requests. Current membership capability restrictions, private membership and history policies still apply. An empty restriction list permits workspace content and all otherwise accessible conversations; a nonempty list excludes workspace-wide content.

The receiving protocol is:

1. Poll `GET /v1/agent/inbox`, or react to an authorized realtime or signed webhook wake-up.
2. Claim `POST /v1/agent/inbox/:id/lease` with `leaseSeconds` between 15 and 900 (default 120).
3. Persist the returned `lease_token`, integer `fence`, delivery ID and local operation identity before doing work. Concurrent claimers cannot both obtain the delivery.
4. Renew through `POST /v1/agent/inbox/:id/heartbeat`, supplying `leaseToken`, `fence` and an optional lease duration.
5. Report `POST /v1/agent/inbox/:id/result` with that lease identity, `outcome` (`completed`, `retry`, `failed`) and a concise `summary`.

Completion is idempotent for the exact same lease/result. Superseded, revoked, expired or cross-credential leases cannot complete work. A retry returns to pending with exponential backoff; five claims without success produce a dead letter. Deliveries expire after seven days. Administrators can review and explicitly retry dead or expired items; retry creates a new fencing generation. A lease cannot outlive the delivery's expiry. Deleting a source message invalidates its leases and fences its linked hosted run while retaining delivery accounting. Use stable client IDs for separate message/task writes so receiver retries cannot duplicate those writes.

`POST .../accept` now returns `409 LEASE_REQUIRED`. Historical external receipts without confirmed completion migrate to dead letters for review, rather than being silently treated as completed or automatically executed again. Hosted mention deliveries link to their managed run and record its terminal outcome. These records do not automatically complete a linked task or satisfy its acceptance criteria.

## Signed webhook and realtime wake-ups

Register an endpoint at `PUT /v1/agents/:id/webhook` with its current `version` (zero initially), `url` and `enabled`. Every save rotates the signing secret and returns it once. It is encrypted at rest using the configured identity encryption key. The interface also exposes delivery attempts, transport failures and retry controls for current dead webhook deliveries.

Operators must allow exact destination hostnames through `AGENT_WEBHOOK_HOSTS`. Only HTTPS on the default port is accepted. Credentials in URLs, query strings, fragments, loopback/private/reserved addresses and nonpublic DNS results are rejected. The sender pins a validated DNS address, verifies TLS for the original hostname, follows no redirects and uses a ten-second deadline.

The JSON payload contains only `id`, `type: "agent.inbox_ready"`, `agentId` and `inboxId`. It deliberately contains no message body or bearer credential. Verify the raw request bytes using:

```text
webhook-id: <stable delivery UUID>
webhook-timestamp: <Unix seconds>
webhook-signature: v1=<hex HMAC-SHA256>

signed bytes = webhook-id + "." + webhook-timestamp + "." + raw request body
```

Receivers should use constant-time comparison, reject timestamps outside their allowed clock skew, durably deduplicate the delivery UUID and only acknowledge after storing the wake-up. Retries preserve the UUID but refresh the timestamp/signature. Eight unsuccessful attempts produce a transport dead letter, with exponential backoff capped at one hour. PostgreSQL claim tokens fence competing senders. A lost response can cause a repeated HTTP delivery; receiving remains at least once. A transport `2xx` does not complete the inbox item.

New webhook configurations pick up pending inbox work. Superseded destinations and obsolete source deliveries cannot be retried as current work. Access is rechecked before claiming delivery; an already dispatched metadata-only HTTP request cannot be recalled.

Authenticated `/v1/events` and `/v1/events/stream` also publish recipient-private `agent.inbox_ready` changes. Receivers with `inbox.read` use the existing opaque cursor/reconnect protocol. Credential expiry and revocation are rechecked while streaming. Wake-ups are hints to fetch current leased work, not reusable content or authority grants.

## Hosted limits, spending and fair scheduling

Admission locks the workspace and atomically creates both the run and its spending reservation. Idempotency replay cannot reserve twice. The lifetime workspace budget counts settled usage plus outstanding reservations, including uncertain outcomes. Tenant-bound database aggregates include private runs without disclosing their content to the requester. Undispatched cancellation releases its reservation; dispatched cancellation retains it until a result or provider reconciliation supplies accounting evidence.

Policy controls cover open runs (including uncertain work), workspace/agent/requester concurrency, delegation depth and direct child count. Dispatch visits bounded batches of eligible workspaces ordered by recent scheduling, rotates tenant priority and favors requesters who have waited since their last start. Each worker holds at most four local executions; PostgreSQL workspace authority serializes claims and enforces configured limits across replicas. Uncertain sessions continue occupying concurrency until explicitly resolved or cancelled.

Every run captures duration, input/output token bounds, tool-proposal count and a spending reservation in USD micros. The managed service accepts only operator-approved models, limits the provider output tokens, conservatively bounds input using the serialized provider envelope's UTF-8 bytes plus overhead, and permits one model call. It disables default tools and rejects additional SDK model calls through the wrapped call boundary. Oversized results or usage outside the configured reservation cannot publish actions.

Configure matching values in the API and managed runtime:

```text
AGENT_MODEL=<approved AI Gateway model ID>
AGENT_APPROVED_MODELS=<optional comma-separated approved IDs>
AGENT_MODEL_PRICING_JSON={"<model ID>":{"inputMicrosPerMillion":<integer>,"outputMicrosPerMillion":<integer>}}
EVE_DURABILITY_QUALIFIED=false
AGENT_WEBHOOK_HOSTS=<optional exact HTTPS destination hostnames>
```

One USD is 1,000,000 micros. Rates must be conservative upper prices for the selected model and routing path, including any applicable provider pricing. The reservation must cover both token bounds at those rates before dispatch. Missing pricing fails closed. These are application accounting controls; they do not provision a provider billing account or include infrastructure/tool charges. Operators must maintain the rates when provider pricing changes. Actual reported overages remain charged and block further admission when the budget is exhausted.

Successful usage settles against runtime receipts. Missing provider cost conservatively consumes the full reservation. Provider failures after dispatch retain a reservation. Administrators can supply final provider receipt evidence through `/v1/runs/:id/spending`; settlement is terminal and audited. A stopped root run cannot restart while its spending remains unresolved. The budget is a lifetime ceiling for this ledger; increasing it does not erase old spending. Migration backfills reservations for existing open runs and conservatively settles approval-waiting legacy generations. Pre-migration terminal model charges are not fabricated or backfilled; operators should account for those charges when choosing their initial ceiling.

## Checkpoints, resume, restart and exports

Prepared, dispatched, settled and recovered checkpoints are persistent and append only. Lease renewal is conditional on the exact claim and bounded by the deadline. No database transaction remains open over runtime network work. Worker shutdown aborts observations and drains active jobs.

A worker interruption before dispatch can safely requeue. An interruption after dispatch becomes `outcome_unknown`; the platform never automatically resends the model input. **Check hosted result** reads settled remote history without making a new model request. **Resume existing session observation** reattaches to the same session and stream, without sending input. It requires an adapter that advertises observation recovery and an operator-qualified durable deployment. **Restart as a new run** is an explicit, separately reserved attempt for a stopped, reconciled root run and retains its predecessor link.

The eve adapter defaults to a maximum five-minute observation window. Set `EVE_DURABILITY_QUALIFIED=true` only after testing persistent storage, process restart, stream replay, cancellation and replica behavior for the actual deployment. Qualified configurations may observe for up to twenty-four hours, with leased renewal and source authority checks. Qualification is not automatic failover or a claim that a live model was tested in this repository run.

Task run histories show current execution progress and independent verification state. Run details expose bounded checkpoints and paginated public status/action/result traces. Export includes the authorized result, action ledger and linked task artifacts. Runtime service credentials, remote session IDs, raw model streams and private reasoning are excluded. Export limits fail explicitly instead of truncating: 10,000 trace entries and 1,000 task artifacts; use paginated endpoints for larger histories.

## Delegation and independent verification

Create a delegation from a run manually or through an approved, granted `delegate_agent` proposal. A delegation has a named active human owner, a different independent human verifier, an explicit output contract, deadline, budget and stop condition. The verifier cannot be the originating requester. Owners, verifiers and the target agent must have access to the source run's history and retain the required read/execution capabilities. An optional linked task must share the source conversation, remain readable to the target agent, and be manageable by the original requester.

The parent determines the conversation and originating requester; these cannot be widened. Child tools and skills intersect the parent's grants, and token/time/tool limits cannot grow. Every child receives its own workspace spending reservation. Root delegation allowance equals its configured reservation in addition to its own model reservation. A delegated child's budget covers its own reservation plus allocations to its descendants. Ancestors cannot be delegated to again. Depth, direct child count, exact request-key payload identity and budget allocation are checked under workspace authority. Reusing another run's request key cannot reparent that run.

Deadlines cannot exceed one day or an ancestor deadline. Owner/verifier suspension, ancestor cancellation/failure, rejected verification and expiry fence later publication and tool execution. The worker stops affected children and escalates failed, uncertain or overdue work to its named reviewers, respecting notification preferences and current source visibility. Natural-language stop conditions are supplied to the runtime; enforceable deadlines, budgets, grants and lifecycle fences remain control-plane checks. The owner can explicitly cancel the child when a semantic stop condition is met.

Run success describes generation and approved local actions. It does not imply that delegated work was independently accepted. Coordination reports pending, verified or blocked descendants separately. Workflow agent steps wait for descendant verification and escalate blocked delegation. Only the current named independent verifier can accept or reject a successful child result with recorded evidence. Verification does not itself complete a task or bypass its acceptance criteria.

## Verification and deployment boundaries

Integration and browser suites use deterministic adapters to verify leases, replica claims, budget races, immutable revisions, source audiences, recovery without redispatch, delegation limits and independent review. CI compiles the managed runtime without inference and runs embedded PostgreSQL, real PostgreSQL and production-browser suites.

Live provider billing, inference, public webhook transport and persistent deployment recovery require operator-owned configuration and qualification. The implementation does not enable arbitrary shell/code execution, unreviewed third-party tools, application-level automatic model fallback, or remote checkpoint migration between incompatible runtimes. Those remain separate capabilities with their own execution and approval boundaries.
