# Extended tasks, projects, workflows and calendars

Migrations `036_work_management.sql` and `037_calendar_sync.sql` extend the existing collaboration model. Existing task IDs, owners, assignments, task graphs, project placement, due dates and state histories are preserved. The new services use the same tenant roles, conversation history grants, workspace locks, task graph lock, version checks and transactional event records as existing task management.

## Task collaboration and verification

Task participants have one role per task: **watcher** or **collaborator**. A person can follow or stop following a visible task. Task managers can add other eligible participants and grant collaboration. Collaboration permits task management without changing its creator, assignee, project, conversation or audience. A participant must already be able to read the task, including its join-time history. Removing conversation access does not leave a usable task grant. Task updates, assignments and comments notify eligible participants according to their current notification preferences.

Acceptance criteria are separate records, with a required/optional flag. A human task manager records acceptance, evidence and an optional artifact reference. Every review is appended to an immutable verification ledger. Closed-task verification cannot be edited. A database trigger prevents completion while any required criterion is unverified; interactive transitions, bulk operations and hosted tools all encounter the same gate. The existing final human completion evidence requirement also remains in force. Recurring tasks copy criteria as unverified criteria on each occurrence.

Artifacts are immutable, typed records: link, attached file, document, decision or test result. They include attribution, a client request key, outcome, title, details and an optional HTTP(S) URL or existing task attachment. Provider/test outcomes do not themselves accept a criterion. A file artifact must reference an active attachment on the same task. Retrying the original artifact request cannot duplicate it or change its payload.

Discussion and decision links reference real messages, not copied message snapshots. Linking requires message-read capability, task management and a matching conversation audience. Reads also enforce the message's current visibility and deletion state. Private-group history expansion checks existing task, project, knowledge and run context even when the group has no messages. Permalinks do not grant access.

A task can retain multiple hosted agent runs. Starting a task run uses existing hosted admission, approval policies and execution capabilities. The requester and selected agent must be eligible for its source conversation/history. Existing authorized runs in the same conversation can also be linked. Task attribution and assignment do not change when attempts start, fail, or are linked later. Viewing run history requires execution-read capability in addition to task access.

Tasks also have an optional planned start date and estimated effort. The planned start cannot follow its due date. Concurrent edits preserve the plan draft and require explicit review of the current task version.

## Published templates and durable workflows

Task templates and workflows have a fixed audience and immutable, numbered definition revisions. Revising a template creates a new revision; publishing chooses a revision for new manual starts. Each admitted run retains its original revision. A task template contains task-creation steps; a workflow can contain:

- Create a task, optionally with required criteria, an assignee, relative due date, business calendar, project and a parent created by an earlier step.
- Transition the source task or an earlier created task through permitted workflow states.
- Wait for a task to reach a configured state.
- Wait for a human approval or rejection with decision evidence.
- Start a hosted agent against a task, retain its task-to-run link and wait for its terminal result.

Definitions contain at most 50 steps. Stable, unique step keys bind references and persisted outputs. A step may reference the source task or an earlier task-creation step. Automatic task completion is excluded from workflow transitions: human acceptance and final verification remain required.

`WorkflowWorker` runs with the API and sweeps every five seconds. It processes bounded event and run batches, under tenant scopes and a consistent workspace → task graph → workflow/source resource lock order. Each local action, its step output, task changes, run admission and event records commit together. External inference does not run inside a database transaction. Database transactions serialize concurrent worker replicas; a process can restart and resume persisted work.

Event triggers subscribe to task creation, task updates, state transitions or new comments. Optional project and state filters narrow the trigger. The transaction that changes a task captures its event and version. Triggers retain the immutable revision configured when they were created. Workflow-generated task events carry an origin run and are not recursively dispatched into more event-driven workflows. A revoked or ineligible trigger is disabled for review.

Every step revalidates the owner's active account, verified email, credential epoch, organization policy version, current capabilities and resource access. A credential/policy change requires a new reviewed run. Expected authorization, validation and execution failures close the workflow for review. Unexpected local failures roll back to the action savepoint and retry with bounded exponential backoff, with at most five attempts. There is no external network call while a workflow database lock is held.

Human approval is available to the run owner or a current human administrator with task write access. A rejection fails the run. The configured deadline bounds waits as well as ordinary execution. Approval and escalation notices are persisted and delivered through the private inbox. The configured escalation person must still be eligible for the workflow audience.

Manual replay creates a new run linked to its predecessor and keeps the predecessor's immutable revision. Already successful step outputs are reused, including created task IDs. Failed work is retried under current authority. An unresolved or nonterminal previous agent attempt blocks replay. Cancellation and terminal failure fence queued/running child agent executions and their unexecuted proposals. An already unknown external outcome remains unresolved and must be reconciled before replay; it is not turned into success or a safe retry by cancelling the workflow.

Offboarding stops owned active workflows, disables triggers, archives owned templates, removes participation records and invalidates calendar credentials/subscriptions. Historical attribution is retained. Administrators can review archived definitions and create newly authorized runs rather than silently transferring background execution authority.

## Project reporting, timelines and portfolios

Project reports include task counts by state, estimated effort, overdue and blocked work, workload by assignee and a weekly completion trend over the last 12 weeks. Counts include subtasks; estimated effort is the sum of the estimates explicitly recorded on tasks. Cancelled tasks do not count as completed work. Overdue calculations use UTC calendar dates.

The project timeline shows planned starts, due dates, states, assignees, estimated effort and prerequisite counts, with bounded keyset pages over a date window of at most 367 dates. Undated work remains visible as unscheduled. Task planning remains in task details, where normal version and graph checks apply.

Portfolios group up to 200 projects within one fixed audience. They provide project status, schedule dates, counts, overdue/blocked work and estimated-effort rollups. Report totals cover the complete visible portfolio, independently of the current project page. Editing retains project selections outside the currently loaded chooser page. Reports and timelines require both project-read and task-read capability. Forced row policies narrow every aggregate and linked record to current conversation/history access.

## Business-day scheduling

Administrators configure named business calendars with an IANA time zone, working weekdays and explicit holiday dates. Recurrences can use **Business days** as their frequency, with an interval measured in working days. A nonworking anchor starts on the next working date; weekends and configured holidays are skipped. Existing daily, weekly and month-end recurrence semantics are preserved.

Saving a business recurrence captures the calendar ID, name, time zone, weekday set, holidays and version. Later calendar edits do not silently change an already authorized recurrence. A person reviews and saves that schedule to adopt new rules. The existing occurrence ledger prevents duplicate materialization. Previews use the same date arithmetic as the worker. PostgreSQL converts the configured local occurrence time to an instant in the captured zone.

Workflow task creation can also measure relative due dates in business days. Calendar settings are available under **Tasks → Calendar settings**.

## Google Calendar and iCalendar

Calendar connections are personal to one workspace membership. Google synchronization exports **assigned workspace-scoped tasks** with due dates into the connected account's primary calendar. Conversation-scoped tasks are excluded. This deliberately keeps private conversation history and attachments out of external calendar exports. Connecting requires an explicit browser action and Google's consent screen.

The Google OAuth flow uses the official `google-auth-library`, a random single-use state, a browser-session binding, PKCE, a ten-minute expiry and captured credential/organization policy versions. Access and refresh credentials are authenticated-encrypted using the configured identity key, with a connection-bound context. API responses and request logs do not disclose credentials. The integration requests `calendar.events.owned`; the application operates on its own stable event IDs and never imports unrelated events into tasks.

`CalendarSyncWorker` sweeps every fifteen seconds and schedules active connections approximately once per minute. Each connection has an expiring claim token. Provider I/O runs outside database transactions and uses fixed Google endpoints, deadlines and bounded batches. Every persisted result rechecks the claim and current owner authority. Incremental synchronization preserves Google's page/sync tokens; an expired sync token causes a fresh scan. Provider rate limits and transient failures back off. Revoked credentials or account authority require reconnection.

Before writing an event, the worker persists its intended payload and task version. Stable provider event IDs and the pending ledger recover a lost response without creating a second event. Updates use ETags. External edits or deletion become reviewable conflicts rather than a last-writer overwrite. A member can keep the task date, accept a usable external date with the current task version, or stop synchronizing that event. Completion, cancellation, loss of assignment, and removal of the due date remove the exported event on the next successful synchronization. An API request already in flight cannot be retroactively stopped; subsequent work and local commits remain fenced.

Disconnecting clears the app's credentials and stops further synchronization. Existing external events remain in the Google account; its owner can remove those copies and revoke the grant in Google account settings. Offboarding cannot erase copies already exported to an external account.

Expiring iCalendar subscriptions work with clients that accept a private calendar URL. Tokens are shown once, stored as hashes, valid for 90 days and explicitly revocable. Feed requests revalidate account, organization and permission authority. The feed covers assigned workspace tasks from 30 days before today to 366 days ahead, including cancellation status, and rejects rather than silently truncating a result over 1,000 events. Text is escaped and folded by UTF-8 byte length. Treat a subscription URL as a bearer secret; subscribed clients may retain previously fetched data.

### Operator setup

The local product works without live Google credentials. To enable live synchronization:

1. Enable Google Calendar API in a Google Cloud project and configure its OAuth consent screen and permitted test/production users.
2. Create a Web application OAuth client. Register the exact redirect URI `<WEB_ORIGIN>/api/v1/calendar/google/callback`. For local development, this is `http://localhost:3000/api/v1/calendar/google/callback`.
3. Set `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, and the existing canonical base64 32-byte `IDENTITY_ENCRYPTION_KEY`. Use a stable HTTPS `WEB_ORIGIN` in production.
4. Restart the API, open Calendar settings, and select **Connect Google Calendar**. The operator credentials configure the product; each end user still grants their own calendar access.

Provider protocol references: [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [incremental calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), and [conditional ETag modifications](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Verification and operating limits

API integration tests cover criteria gates, collaboration, immutable artifacts, source audience matching, template versions, idempotent admission, concurrent worker replicas, human decisions, deadlines, replay, child-run cancellation, portfolio/reporting scope, business dates, OAuth state/session fencing, subscription revocation and provider response-loss recovery. PostgreSQL runs verify real role grants, foreign keys and pooled concurrency. Browser tests exercise the corresponding product interfaces against the production web build.

Live Google consent is operator-dependent; adapter tests use controlled provider responses and never alter a personal calendar. Production qualification still includes real-provider consent/refresh/revocation, quota behavior, reverse proxies, crash/lease recovery, multi-region operations, fleet load, accessibility and restore drills. Additional providers, arbitrary code/HTTP workflow steps, general external side-effect reconciliation, independent project chat and portfolio-level dependencies remain separate full-product capabilities.
