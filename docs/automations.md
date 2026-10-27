# Automation platform

Automations are versioned authority-bound definitions, distinct from recurring task records. Their actions dispatch through the existing hosted execution or workflow engine. The platform does not create a second agent runtime or bypass approvals.

## Definitions and controls

A definition binds a verified human owner, destination conversation, schedule/event rule, immutable workflow or agent revision, overlap/concurrency policy, daily start/spending allowances, execution deadline, escalation recipient and publication policy. Workflow agent revisions are captured in an authority snapshot. New or revised definitions start paused. An owner resumes only after reviewing current access, published template state and pinned agent revisions.

The Automations screen supports creation/editing, upcoming occurrences, immutable revision history, paginated run history, pause/resume/archive, reasoned replay and ownership transfer. Revision/version compare-and-swap prevents stale edits. Client request IDs and occurrence keys prevent duplicate creation/admission. Revisions are append-only at the database level. A new definition revision cancels/fences pending work from the old one.

Owners or current administrators with conversation access may pause/archive or offer an ownership transfer. The recipient must have current conversation/execution access and explicitly accept the same revision. Transfer keeps the definition paused until its new owner resumes. Suspension/offboarding, account changes, organization policy changes, agent revision changes or lost source access stop future admission; current execution checks fence already queued work and tool actions. Ownership is never silently reassigned to an administrator.

## Scheduling semantics

Schedules use deterministic five-field cron expressions and IANA timezones, at minute granularity. Weekday expressions support recurring business-week checks; workflow steps retain the existing holiday-aware business calendar offsets. Randomized/sub-minute expressions are excluded.

DST policy is explicit: skip a nonexistent wall time, or shift it past the spring gap. A repeated fall-back wall time runs once, at its first occurrence. Upcoming previews use the same parser and policy as admission. Tests exercise both transitions in America/New_York.

A due occurrence outside its grace window follows one of three policies:

- Skip: record a missed occurrence and advance past the outage.
- Coalesce: admit one recovery check and advance directly to the next future time.
- Catch up: admit the configured bounded number (1–10) of missed checks, then advance past the outage. The bound applies to the outage, not repeatedly on every tick.

Overlap can skip or queue. Per-definition concurrency is 1–10, pending work is bounded, and a workspace can retain at most 1,000 definitions. Each scheduler replica locks the workspace during admission; occurrence uniqueness and transactional child run creation make recovery safe after process interruption. Scheduling transactions do no external I/O. Existing execution/workflow workers retain their own leases, execution concurrency, model/tool/token/time limits and checkpoint recovery rules.

Daily starts, publications and spending allowances reset on UTC boundaries; display and quiet-hour zones are separately explicit. Before an agent reservation is inserted, the same workspace lock checks reserved plus reconciled spending against the automation allowance and workspace budget. Delegated and workflow-started agent runs inherit the automation origin. Unknown provider usage remains conservatively reserved/charged according to the execution ledger, rather than being treated as free.

## Event rules and source authority

Rules select supported message/task/knowledge/import events within their exact destination conversation. The committed outbox records source actor and automation origin. Rules ignore agent-authored events and automation-originated changes to prevent feedback loops. Optionally ignore the owner's own activity.

Event cursors are durable and scoped to each definition. Dispatch rechecks current owner authority, source existence, history interval, source permissions and conversation placement; a removed or inaccessible source produces an inspectable skipped occurrence. Task-comment events resolve their actual parent task. Mixed event rules do not treat message IDs as task IDs. Activating/resuming a definition starts event capture at the current committed position, without replaying events accumulated while paused.

## Publication and noise control

Participation may be disabled, constrained by quiet hours, limited by daily publications and cooldown, or restricted to meaningful changes. An unchanged normalized reply hash or an explicit `meaningfulChange:false` result suppresses the public reply. This is a conservative rule, not a claim that the system can independently prove the semantic novelty of every model answer.

Publication decisions are checked again at result commit. Suppression reasons remain in run/history records. Suppressing a message does not drop proposed actions: tool invocations and their normal human approvals remain inspectable. The definition's report includes occurrence/failure/suppression counts and actual/reserved execution spending.

## Failure, replay and escalation

Occurrences link directly to hosted runs or workflow runs. An uncertain outcome continues occupying its overlap slot; qualified read-only recovery remains possible under the current owner, revision, source authority and deadline. Delegated work keeps the occurrence open until independent verification finishes. Reconciliation observes terminal child state; deadlines fence the affected occurrence and its children. Failed/uncertain outcomes create private persistent notifications for the owner or explicit recipient, subject to their current access and notification preferences. Notifications open the authorized automation history.

Replay requires an active reviewed definition, a terminal occurrence, a reason and a durable client ID. It uses the current definition revision and records `replay_of`. An unresolved dispatched reservation or uncertain provider outcome blocks replay. Replay never asserts that cancellation undid an external operation. Changing ownership/definitions does not release uncertain spending reservations or resend unknown actions.

## Operation and verification

`AutomationWorker` is started and stopped with the API. No hosted service or external account is provisioned automatically. Relevant contracts are in `packages/contracts/src/automations.ts`; tables/policies are in migrations 062 and 065; implementation is in `apps/api/src/automations`.

Verification covers DST, replica admission, catch-up, overlap, source filtering, current authority, version history, ownership acceptance, pinned revision fencing, meaningful-change suppression, retained approvals, daily spending and escalation. Browser tests cover the actual definition editor, previews, history, pause and revision flow. Live model/provider qualification remains separately pending; the local suites use deterministic runtimes and provider fixtures.
