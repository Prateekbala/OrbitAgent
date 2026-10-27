# Product specification and research

This document preserves the original product scope and reference research. For the current product overview, see [Orbit](../readme.md). For delivered behavior and remaining release work, see [implementation status](implementation.md).

A team workspace where people and AI agents communicate, share knowledge, coordinate work, and make decisions together.

**Status:** Implementation started. The repository now contains a runnable web application, a persistent API, shared contracts, SQL migrations, and integration/browser tests. See [implementation status and setup](implementation.md) for verified behavior and remaining full-product work. Hosted execution, approval-gated tools, team invitations with email delivery, email verification, password recovery, member management, workspace switching, database tenant isolation, live messaging, guarded message edits/deletion, reactions, read receipts, unread counts, direct messages, owner-managed private groups, private file attachments, recipient-private in-app notifications, online/away/invisible presence, and expiring typing indicators are implemented. A local Mailpit inbox supports development without live email or a domain. External email supports Gmail with a Google app password or Resend with a verified domain. Live inference and email require operator configuration. No production deployment or business integration accounts are configured.

Retrieval now includes cross-content evidence search, source-aware indexing and optional real embeddings/OCR, cited extractive answers, inspectable memory and explicit declassification. Owned connections include a 24-entry catalog with bounded reads, native approved updates for nine providers, OAuth for eight, encrypted credentials, signed event delivery and email-to-channel. See [implemented behavior, setup and qualification limits](retrieval-and-connections.md). Live provider validation remains pending by request. Automatic remote subscription provisioning, binary/Office exports and production scale qualification remain outside the implemented catalog boundaries.


Agent lifecycle, versioned configuration, scoped credentials, durable inbox delivery, signed wake-ups, hosted budgets/checkpoints and independently verified delegation are implemented. See [agent execution controls and operator setup](agent-execution.md).

Versioned tools, approval policies, owned provider adapters, isolated execution, collaborative knowledge, reviews, source lineage and retention are implemented. See [tools and knowledge protocols, setup and remaining integration boundaries](tools-and-knowledge.md).

**Scope:** The complete product, including production operations and enterprise capabilities. Delivery stages describe dependencies and release gates; they do not reduce the intended product scope.

**Research date:** October 23, 2026.

**Working name:** AgentOrchestration. Choose an original product name, visual identity, interaction design, and implementation before launch. Ando is a research reference; this project is not affiliated with Ando or Asari Inc.

Read [architecture.md](../architecture.md) for system boundaries, data models, execution contracts, security rules, failure recovery, infrastructure, and implementation sequencing.

Account and organization management now includes multi-workspace organizations, DNS domain verification, regional assignment and security policies, editable profiles, verified credential changes, session management, TOTP MFA, OIDC/SAML login, SCIM user/group provisioning, guest/service accounts, capability controls, ownership transfer, and offboarding/restoration. See [identity setup and verified behavior](identity.md) for exact boundaries and production provider/infrastructure requirements.

Messaging now includes rich text and identity-based agent mentions, pins/saves/permalinks/thread following, durable drafts and scheduled delivery, protected offline sending, customizable sidebars, channel discovery and archive/restore, consent-bound private history, and virtualized timelines with paginated administration views. See [messaging behavior and operating details](messaging.md).

Extended work management now includes task watchers/collaborators, acceptance criteria and verification ledgers, structured artifacts and source/run links, published task/workflow revisions, durable event-driven workflows with approvals/replay/escalation, project reports and timelines, portfolios, business-day recurrences, and Google/iCalendar synchronization. See [work-management behavior and operator setup](work-management.md).

The running application now includes advanced message and knowledge search, older/newer message and reply navigation, collaborative knowledge editing with immutable version history, and task management with nested subtasks, dependencies, due dates, discussion and completion evidence. It also includes recurring schedules, due-date inbox reminders, a month calendar with future occurrence previews, private task attachments, atomic bulk actions, a Kanban board, audience-scoped projects, milestones with completion gates, and workspace task labels. See [delivered behavior and API contracts](implementation.md) for the exact implementation; the full release program below remains the scope.

## 1. Product purpose

Teams increasingly use multiple agents, but a person often has to move context between a team conversation, a coding assistant, an issue tracker, and a document. Work loses continuity at those boundaries. Agents do not reliably know who owns a decision, which facts are current, when they should speak, or when a human must approve an action.

AgentOrchestration will make the shared workspace the place where that coordination happens. People and agents participate under explicit identities. Conversations generate attributable tasks and durable knowledge. Agents can investigate, propose, execute permitted work, and request decisions without losing their place when a process stops.

The product has four connected responsibilities:

1. **Communication:** Dependable messaging, search, calls, files, and notifications.
2. **Context:** Permission-aware access to discussions, decisions, documents, and connected systems.
3. **Execution:** Persistent tasks, agent runs, tool calls, approvals, and recoverable handoffs.
4. **Control:** Clear ownership, permissions, spending limits, audit trails, and administrative oversight.

The principal product outcome is less human coordination effort per successfully completed team task. Message volume and agent activity alone are not success metrics.

## 2. What the Ando research establishes

### Company and positioning

Ando describes itself as a replacement for Slack, built around humans and agents sharing a workspace. It is operated by Asari Inc. Its founder and CEO is Sara Du, who previously founded Alloy Automation. The company profile lists a 2025 founding date and San Francisco headquarters. [Ando introduction][s-intro], [company profile][s-company]

Ando announced $20 million in funding on September 24, 2026. Funding descriptions differ: the press release and Emergence use seed terminology, while Accel distinguishes an Accel-led pre-seed from a seed led by Index and Emergence. Treat the announcement as $20 million of disclosed funding across the early rounds; do not combine inconsistent directory totals. [Company announcement][s-funding], [Accel announcement][s-accel]

### Documented product behavior

These are vendor-documented capabilities, not capabilities tested in an authenticated Ando workspace during this research.

| Area | Publicly documented behavior | Implication for this project |
| --- | --- | --- |
| Agent membership | Agents have identities, conversation membership, notification settings, and restricted access to private conversations. | Make identity and authorization foundational. |
| Hosted and external agents | Ando runs agents or connects existing runtimes through developer interfaces. | Support both execution ownership models. |
| Context | A shared wiki, channel context, journals, dictionary, and separate hosted-agent memory are documented. | Separate canonical knowledge, summaries, and runtime memory. |
| Calls | Jams support audio, with web/desktop video and screen sharing. Agents consume transcripts rather than speaking in the call. | Treat transcripts as permissioned conversation artifacts. |
| Integrations | Tools and event feeds connect business applications, subject to connection and agent permissions. | Distinguish credentials, permissions, tools, and inbound events. |
| Migration | Public feature documentation describes selected public Slack channels and up to 180 days of history, with limited outbound synchronization. | Build migration as a verified compatibility subsystem. |

Sources: [agents][s-agents], [external agents][s-byo], [wiki][s-wiki], [calls][s-calls], [integrations][s-integrations], [Slack import][s-slack-import].

### Availability, pricing, security, and evidence quality

- Ando still describes waitlist-based onboarding. Web, desktop, and mobile surfaces are described; public iOS and Android listings exist. An app download is not evidence of unrestricted workspace onboarding. [FAQ][s-faq], [iOS][s-ios], [Android][s-android]
- Pricing is described as per human seat, but the public pricing page does not provide rates or promise unlimited compute, messages, or third-party services. Exact economics require an onboarding quote. [Pricing][s-pricing]
- The security page, reviewed October 18, 2026, says SOC 2 Type I was completed in July and the Type II observation period is complete with its report being prepared. This research did not inspect those reports. [Security][s-security]
- The launch announcement reports use across roughly a dozen countries. The April field study describes Truth Systems using Ando in its engineering workflow. These are early adoption signals, not audited retention, revenue, reliability, or productivity measurements. [Company announcement][s-funding], [field study][s-study]
- The US iOS listing showed 4.3/5 from 10 ratings when checked. That is too small a sample to establish general satisfaction, and it describes the mobile application rather than the whole service. [iOS][s-ios]

### Public inconsistencies and unresolved questions

1. **Slack import:** The feature page excludes private channels, while the documentation index describes public and private channels. The detailed import documentation could not be retrieved through the research browser. Private-channel support remains unverified. [Import page][s-slack-import], [documentation index][s-doc-index]
2. **Privacy disclosures:** The iOS listing says no data is collected, while the website policy describes collecting account, usage, and device information and processing messages and files. The Android listing also declares collection. The disclosures need reconciliation; they do not establish a breach. [iOS][s-ios], [privacy policy][s-privacy], [Android][s-android]
3. **Data processing:** The reviewed policy does not explicitly settle model-training use, every model subprocessor, exact regional residency, or deletion timing across derived memory. These require direct clarification. [Privacy policy][s-privacy]
4. **Feature rollout:** Wiki synthesis and some outbound Slack behavior are workspace-dependent. A documented feature is not necessarily enabled for every account. [Wiki][s-wiki], [import page][s-slack-import]
5. **Implementation:** Public descriptions do not reveal Ando's actual databases, queues, orchestration framework, deployment topology, or complete algorithms. The architecture in this repository is our proposed implementation.

### Competitive reality

The opportunity is not exclusive access to agents inside chat. Slack already documents third-party agents, Agentforce agents, and collaborative code channels. Teams documents meeting and channel agents. Block's Buzz provides a self-hostable, open-source workspace for humans and agents. [Slack documentation][s-slack-agents], [Teams documentation][s-teams], [Buzz repository][s-buzz]

Our proposed differentiation is the coherence of the full workflow: explicit agent identity, explainable context, reliable task ownership, safe cross-agent handoffs, inspectable memory, controlled interruption, and understandable cost. Each must prove better in real work than assembling comparable behavior from existing tools.

## 3. Users and buying criteria

| User | Main need | Product responsibilities |
| --- | --- | --- |
| Founder or team lead | Coordinate a team containing people and several agents | Ownership, decisions, activity visibility, spending controls |
| Engineer | Delegate implementation and investigation with accurate context | Code tools, reproducible runs, previews, review and release gates |
| Product or design lead | Turn discussion into decisions and deliverables | Decision records, proposals, files, feedback, linked tasks |
| Operations or customer team | Coordinate recurring work and exceptions | Integrations, schedules, queues, escalation and reporting |
| Research team | Build shared, attributable understanding over time | Search, citations, knowledge revisions, contradiction handling |
| Agent developer | Connect an existing runtime without rewriting it | MCP, HTTP API, events, inbox, scoped credentials, SDKs |
| Workspace administrator | Control access and organizational data | Identity provisioning, policies, audit, retention, export |
| Enterprise buyer | Assess deployment, contractual and operational fit | Residency options, incident process, SSO, lifecycle controls, service objectives |

Teams already using agents collaboratively are a natural initial customer segment. The complete design must also work for ordinary users who never write a prompt, configure a model, or inspect a trace.

## 4. Complete product specification

Everything in this section is a **planned requirement**, not a claim of existing implementation or Ando parity.

### 4.1 Organizations, workspaces, and identity

- Organizations with multiple workspaces, a billing owner, domain controls, and regional placement.
- Human, agent, guest, and service identities with explicit attribution in every surface.
- Roles for owner, administrator, member, guest, and narrowly scoped operational services.
- Email and federated sign-in, MFA, enterprise SSO, session management, and SCIM provisioning.
- Invitations, expiry, verified acceptance, offboarding, agent ownership transfer, suspension, and archival.
- A roster that shows agent owner, runtime type, availability, permitted capabilities, and current work.
- Shared channels between organizations with explicit invitations, participant lists, and a common retention agreement.

### 4.2 Messaging and personal organization

- Public channels, private channels, direct messages, group conversations, and threads.
- Rich text, mentions, reactions, attachments, edits, deletion, pins, saved messages, and permalinks.
- Read state, unread counts, thread following, drafts, scheduled messages, and presence.
- Sidebar sections, channel discovery, archive and restore, keyboard navigation, and accessibility.
- Reliable reconnect, duplicate prevention, visible sending state, and an offline outbox.
- External identity attribution for imported messages; imported history must never appear newly authored by a local person.
- A unified inbox for mentions, assignments, approvals, failed runs, and important decisions.

### 4.3 Agent membership and execution

- Create platform-hosted agents or invite agents operated elsewhere.
- Versioned role instructions, model policy, permitted tools, skills, resource access, and behavior settings.
- Per-conversation activation settings: explicit requests, mentions, selected event types, scheduled checks, and controlled proactive participation.
- Persistent execution with run status, cancellation, checkpoints, retries, and recovery after deployment or failure.
- Readable progress updates linked to tasks and tool results rather than unfiltered internal traces.
- Agent-to-agent requests and delegated subtasks with an owner, expected output, deadline, budget, and stop condition.
- Limits on concurrency, delegation depth, reply chains, tool calls, elapsed time, and spend.
- Visible distinctions between agent-reported completion and independently verified completion.
- Runtime health and capability tests for external agents; no implied always-on behavior from an MCP connection alone.

### 4.4 Tasks, workflows, and approvals

- Tasks with an accountable owner, watchers, collaborators, dependencies, deadlines, artifacts, and source discussion.
- States for proposed, queued, active, blocked, awaiting approval, awaiting review, completed, failed, and cancelled work.
- Explicit acceptance criteria and verification evidence before completion.
- Recurring and event-driven workflows, versioned templates, run history, and manual replay controls.
- Approval cards showing the exact operation, destination, account, parameters, expected effect, and expiry.
- Policy-defined approval requirements for publication, deployment, payments, sensitive exports, destructive changes, and access expansion.
- Escalation to humans when agents lack access, encounter ambiguity, reach limits, or cannot verify an outcome.
- A task can span multiple runs; restarting an agent must not reset ownership or erase its history.

### 4.5 Knowledge, memory, and search

- A shared wiki with structured pages, version history, author attribution, comments, and review ownership.
- Workspace terminology, decisions, procedures, project context, channel summaries, and daily journals.
- Search across messages, files, knowledge, tasks, and retained call transcripts, filtered by current access.
- Answers with source links and clear indication of missing, conflicting, or stale evidence.
- A scheduled synthesis process that proposes durable knowledge from eligible conversations.
- Inspectable agent memory with provenance, scope, expiry, correction, and deletion controls.
- Separate private memory, conversation memory, and workspace knowledge; no silent promotion between audiences.
- Human corrections and canonical decisions take precedence over speculative or superseded summaries.
- Export of knowledge and its provenance, with documented handling of vendor-specific runtime state.

### 4.6 Calls and meeting outcomes

- Conversation-bound audio, video, screen sharing, participant controls, and device selection.
- Explicit recording policy and an obvious recording/transcription indicator for all participants.
- No recording, transient transcription, and retained recording modes.
- Timestamped transcripts, speaker attribution where available, summaries, chapters, and linked action items.
- Permission inheritance from the conversation and separate retention controls for media and transcripts.
- Transcript access for agents without requiring agents to speak in calls.
- Live voice-agent participation as an additional product capability with separate consent, interruption, and cost controls. This extends beyond Ando's documented transcript-only agent behavior.

### 4.7 Integrations and developer platform

- Workspace-owned and personal account connections, each with explicit owners and consumers.
- Separate controls for read tools, write tools, resource boundaries, and inbound event subscriptions.
- Engineering connectors: GitHub, GitLab, Linear, Jira, Sentry, Honeycomb, Vercel, and infrastructure observability.
- Knowledge and meetings: Notion, Google Drive, Microsoft 365, Granola, Fathom, and Fireflies.
- Business operations: HubSpot, Attio, Stripe, Ramp, and relevant commerce or support systems.
- Analytics and data: PostHog, Hex, Supabase, and approved database access.
- Custom remote MCP connections, signed incoming webhooks, outbound webhooks, and email-to-channel.
- REST API, MCP server, realtime subscription API, SDKs, service documentation, scoped keys, and OAuth identity selection.
- A connector registry documenting supported operations, permission scope, provider limits, approval rules, and ownership.
- Interactive forms and small workflow applications in conversations, running within a sandboxed capability model.

Connector names define the intended catalog. Availability is subject to implementation, provider permissions, API access, and validation; neither a logo nor a connected account establishes complete coverage.

### 4.8 Attention and notification management

- Per-channel and per-agent notification preferences, quiet hours, device routing, and delivery history.
- Priority for direct requests, deadlines, approvals, task failures, and material decisions.
- Digests and batching for low-priority agent activity.
- Explanations for proactive messages and controls to mute a behavior or change its threshold.
- Separate rules for waking an agent and notifying a person.
- Suppression of agent echo loops and repeated notifications about unchanged state.

### 4.9 Migration and interoperability

- Preflight analysis, channel mapping, identity reconciliation, bounded history import, progress tracking, and integrity reports.
- Slack import and live synchronization governed by the provider's actual granted permissions and limits.
- Explicit supported/unsupported matrices for private conversations, files, reactions, edits, deletes, threads, calls, and agents.
- Origin tracking and deduplication to prevent synchronization loops.
- Dry runs and reversible mappings; disconnecting a source does not silently erase imported content.
- Exports containing readable content, stable identifiers, links, authorship, timestamps, and retained attachments.
- Additional migration adapters for Teams, Discord, and Buzz with separately verified capabilities.

### 4.10 Administration, governance, and billing

- Policy controls for model providers, tools, agent creation, retention, recording, sharing, and external connections.
- Searchable audit events and controlled export to enterprise monitoring systems.
- Data retention, legal holds, deletion workflows, backup expiry, and organization export.
- Human seat billing with explicit included usage and separately disclosed resource consumption.
- Usage reports for models, tools, storage, media, sandbox time, and external runtimes.
- Budgets, forecasts, warnings, hard caps, invoices, plan changes, and subscription lifecycle handling.
- Contractual service levels, support tiers, incident communications, and an operational status page.
- Compliance evidence collection and independent assessments before making certification claims.

### 4.11 Clients and experience

- A responsive web application, native desktop packaging, and iOS/Android applications.
- Consistent identities, permissions, task states, and notification behavior across clients.
- Accessible controls, screen-reader support, reduced-motion settings, keyboard shortcuts, and timezone-aware scheduling.
- Local cache protection, sign-out cleanup, remote session revocation, and deliberate handling of offline drafts.
- Onboarding that demonstrates a complete team workflow, not merely an agent greeting.

## 5. Workflows the complete product must support

| Workflow | End-to-end behavior | Completion evidence |
| --- | --- | --- |
| Bug to reviewed change | A report becomes a task; an agent investigates; another reviews; a person approves protected actions. | Linked issue, patch, checks, review, and release result |
| Discussion to decision | An agent retrieves permitted background, identifies choices, and records the accountable person's decision. | Versioned decision with sources and owner |
| Meeting to follow-through | A recorded discussion yields reviewable actions with owners, dependencies, and deadlines. | Transcript links, accepted assignments, later task outcomes |
| Customer escalation | Connected signals become an investigation with context, an owner, and an approved response. | Source event, investigation artifacts, response audit |
| Ongoing research | An agent monitors approved sources, updates scoped knowledge, and alerts only on meaningful changes. | Cited changes, reproducible inputs, notification record |
| Multi-agent project | Specialized agents share subtasks and review one another within a common task graph. | Bounded delegation, verified outputs, recorded human decisions |
| Knowledge correction | A person corrects an outdated fact; retrieval, summaries, and relevant agent contexts reflect it. | Supersession links and successful stale-answer regression checks |
| Member offboarding | Account access ends; owned work and connections are reassigned or disabled. | Revoked sessions, stopped runs, updated ownership audit |

## 6. Product principles and acceptance standards

1. A person can identify who acted, under whose authority, on which information, and with what result.
2. A private source must not leak through a summary, search snippet, shared agent memory, generated artifact, or notification.
3. An agent's access to information does not automatically authorize publishing it to every conversation the agent can join.
4. No external side effect is considered successful solely because a model says it succeeded.
5. Communication remains usable when models, integrations, or an agent runtime are unavailable.
6. A dropped connection, retried event, or worker restart must not create a duplicate charge, publication, or task handoff.
7. Agent noise and operating cost must be observable and controllable.
8. All features have loading, empty, denied, failed, retry, cancelled, and recovered states where applicable.

Measure time to verified completion, human intervention per task, decision-to-execution delay, useful proactive contribution rate, notification dismissal rate, stale-answer rate, permission failures, cost per completed task, and retention of active teams. Track these by workflow; avoid an aggregate activity score that rewards unnecessary agent chatter.

## 7. Delivery sequence for the full product

Stages establish engineering order. The complete specification above remains the release program.

| Stage | Deliverables | Exit evidence |
| --- | --- | --- |
| A. Domain and trust foundation | Identities, tenancy, policies, schemas, contracts, audit, secure deployment pipeline | Cross-tenant and cross-audience isolation demonstrated |
| B. Communication platform | Messaging, threads, files, search, realtime, web client, offline recovery | Reliable communication and reconnect under failure |
| C. Agent coordination | Hosted/external agents, inbox, runtime adapters, tasks, approvals, tool execution | Complete delegated workflow survives process loss |
| D. Shared intelligence | Wiki, memory, journals, retrieval, synthesis, contradiction and deletion propagation | Cited retrieval and permission regression evaluations pass |
| E. Connected work | Connector catalog, automations, interactive applications, migration, shared channels | Provider-specific acceptance suites and migration reconciliation |
| F. Complete client experience | Calls, transcription, desktop, mobile, accessibility, notifications | End-to-end parity and media/notification field tests |
| G. Enterprise and commercial readiness | SSO/SCIM, governance, billing, export, retention, residency, recovery and support | Recovery drills, reconciled billing, assessed security controls |

Work on billing, security, accessibility, observability, and compliance design starts in Stage A even when later stages complete their user-facing surfaces. Calendar estimates require team size, budget, provider choices, and validated integration effort.

## 8. Engineering orientation

The proposed stack uses TypeScript, React/Next.js, PostgreSQL, a durable event pipeline, an agent runtime adapter built initially around eve, a model gateway, object storage, and a WebRTC media provider. Critical business rules remain in platform-owned services. Runtime and provider choices are implementation decisions, not assumptions about Ando's internals.

The architecture specifies where durable workflow state lives, where retries are permitted, and where humans or providers must reconcile uncertain outcomes. Start implementation from those contracts rather than from a chat UI alone.

Run `npm ci`, configure transactional email using [.env.example](../.env.example), then run `npm run dev` to start the web and API applications. Open http://localhost:3000, create a workspace and confirm your email. See [implementation status and setup](implementation.md) for storage configuration, verification commands, and the exact delivered scope. The architecture directory layout remains the target; only implemented packages are present.

## 9. Decisions required before implementation commitments

- Final product name, initial customer segment, launch jurisdictions, and contractual requirements.
- Deployment regions, data residency, customer-managed infrastructure requirements, and supported client versions.
- Whether live voice agents, an external marketplace, and dedicated tenant deployments are required at initial general availability or later in the full release program.
- Hosted model policy, customer-supplied provider accounts, price packaging, and compute allowances.
- Exact enterprise requirements for SSO, provisioning, retention, audit export, and compliance assessment.
- Delivery team, budget, support staffing, reliability targets, and the connector validation matrix.

Until changed explicitly, architecture.md supplies concrete design defaults so engineering can proceed coherently. These questions do not remove capabilities from the intended product.

## 10. Research sources

Sources were consulted on October 23, 2026. Vendor pages establish published claims and contracts, not independently measured behavior. Investor commentary is evidence of the investor's thesis and participation, not neutral product validation. The field study is qualitative reporting, not a controlled benchmark.

[s-intro]: https://www.ando.so/blog/introducing-ando
[s-company]: https://www.linkedin.com/company/andohq
[s-funding]: https://www.globenewswire.com/news-release/2026/09/24/3368344/0/en/ando-launches-agent-native-messaging-platform-announces-20-million-seed.html
[s-accel]: https://www.accel.com/news/our-investment-in-ando-modern-messaging-for-teams-and-agents
[s-agents]: https://www.ando.so/features/ai-agents
[s-byo]: https://www.ando.so/features/bring-your-own-agent
[s-wiki]: https://www.ando.so/features/wiki
[s-calls]: https://www.ando.so/features/calls
[s-integrations]: https://www.ando.so/integrations
[s-slack-import]: https://www.ando.so/features/slack-import
[s-faq]: https://www.ando.so/faq
[s-ios]: https://apps.apple.com/us/app/ando-team-messaging/id6760619548
[s-android]: https://play.google.com/store/apps/details?id=so.ando.mobile
[s-pricing]: https://www.ando.so/pricing
[s-security]: https://www.ando.so/security
[s-study]: https://www.new-ontologies.com/posts/Ando
[s-doc-index]: https://docs.ando.so/llms.txt
[s-privacy]: https://www.ando.so/security/privacy-policy
[s-slack-agents]: https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack
[s-teams]: https://support.microsoft.com/en-gb/teams/platform/frequently-asked-questions-about-agents-in-microsoft-teams
[s-buzz]: https://github.com/block/buzz

### R09/R10: native writes, consent and cited synthesis

Connections now support native approved updates for nine providers and OAuth consent for eight. Native writes reuse hosted execution approvals, short-lived capabilities and the action ledger; ambiguous outcomes are reconciled by reads, never automatic replays. GitHub, GitLab, Linear and Stripe have native signed-event receivers. Notion imports traverse paginated/nested block text within explicit limits.

Inspectable memory supports an independent source-owner consent inbox for mixed-owner declassification and post-publication withdrawal. Optional model-written search answers bind every claim to exact quoted source support, recheck current authority and reserve bounded daily/concurrent inference allowances. Models remain disabled unless explicitly configured.

See [protocols, provider operations, environment setup and qualification boundaries](retrieval-and-connections.md). Live-provider validation remains pending by request; fixture coverage is not live provider qualification.

### Automations and developer integrations

The Automations view manages immutable definitions, timezone-aware scheduled checks, recurring workflows, event rules, run history, publication noise controls, budgets, escalation and accepted ownership transfers. Definitions dispatch through the existing execution/approval engines. See [automation behavior and operations](automations.md).

Developer settings provide scoped, expiring/rotatable API keys, OAuth application registration and workspace consent, signed webhook delivery history, and reviewed custom remote MCP connections. The public REST API and first-party MCP server share the same operation registry and current domain authorization. See [developer platform](developer/README.md), [OpenAPI](developer/openapi.json), and [connector authoring](developer/connectors.md).

Generate/check client contracts with `npm run api:generate` / `npm run api:check`. TypeScript and Python SDKs and examples are included under `packages/sdk` and `examples/developer`. Set `REMOTE_MCP_HOSTS` and `DEVELOPER_WEBHOOK_HOSTS` to explicit HTTPS destination host allowlists before enabling those outbound integrations. These settings do not start services or provision accounts.

### Migration, synchronization and shared channels

The Migrations view supports reviewed channel/identity mappings, staged dry runs, restartable Slack/Teams/Discord imports, original attribution, scanned file mapping, completeness reports and explicit source/local conflict resolution. Connected sources use encrypted, signed relay credentials and fenced outbound delivery with manual uncertain-outcome reconciliation. Native read transports and an extracted Slack archive converter are included; deploy and independently qualify provider collectors before enabling live synchronization.

Shared channels remain private in an owning workspace. Organization administrators agree to history, retention, export, recording and agent terms and explicitly grant individual participation. External identities remain linked to their original organization; revocation and source offboarding fence reads at the database boundary. Accepted restrictions persist after revocation. Workspace and shared-channel tar exports include readable records, retained binaries and omission manifests.

See [migration, sharing and export operations](interoperability.md). Buzz is excluded from the current provider set by request. Live provider-account validation remains pending; local transport tests do not establish production provider coverage.

### Free local testing stack

Run `npm run local:up` with Docker Desktop running to start the app, API/workers and authenticated agent runtime, plus Docker Mailpit, ClamAV and cloud-disabled Ollama. Existing database/files are preserved. Local chat, embeddings and approved Docker code execution require no paid provider keys. Open [the app](http://localhost:3000) and [captured email](http://localhost:8025). Use `npm run local:status`, `npm run local:verify` and `npm run local:down` for management. See [local setup and limitations](local-development.md).

## Calls and notification delivery

See [calls, consent, transcript editing, delivery configuration and remaining acceptance work](calls-and-delivery.md). Calls use self-hosted LiveKit/Egress. Automatic speech recognition and live voice-agent audio remain unimplemented; APNs/FCM and browser push require device/provider acceptance.

### Files, clients, and commercial controls

Private attachments now support immutable versions, resumable uploads, byte ranges, expiring recipient links, and versioned DLP policy/reinspection. Organization settings expose trials, deduplicated human seats, usage reservations/ledger, budgets, forecasts, billing exports, and a configured Stripe checkout/portal adapter. Desktop and mobile client projects include local build/security checks. See [implementation, operations, verification, and remaining qualification](files-clients-billing.md). Live payments, signed distribution, native device parity, durable native background sync, and complete localization remain pending.


### Enterprise governance and release operations

Organization settings now include versioned governance policy, security audit, legal preservation, scoped support diagnostics and tracked source erasure. Organization archives retain workspace permissions and report omissions. API/worker process separation, shared PostgreSQL rate limits, private metrics and public incident updates are available alongside local container/recovery qualification.

Run `npm run ops:test`, `npm run ops:restore-drill`, `npm run ops:load` and `npm run ops:preflight` for the new local checks. Preflight intentionally fails without deployment configuration and independent signed evidence. See [governance scope](enterprise-governance.md), [production runbook](production-operations.md), [security evidence](security/assessment.md) and [unpublished legal drafts](legal/README.md). Production provisioning, account-level erasure, additional BYOK providers, failover and independent assessment remain open R19/R20 work; local tests do not establish launch readiness.


Organization-wide erasure and isolated customer model keys are now implemented; see [the current erasure/BYOK protocol and deployment boundary](organization-erasure-byok.md). OpenAI is the initial supported BYOK provider. Expo advisories are remediated and gated by real consumer tests; signing/distribution and live provider acceptance remain pending.
