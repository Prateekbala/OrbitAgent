# Implementation status

This document records delivered behavior separately from the complete target in [product specification](product-specification.md) and [architecture](../architecture.md). The full product remains the project scope.

## Running locally

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev
```

Configure transactional email as described below, then open http://localhost:3000 and create an account. Confirm the verification email before entering the workspace. The API listens on 127.0.0.1:4000. There are no default credentials or preloaded conversations. Creating a workspace creates three empty public channels.

You can develop without a domain, Gmail password or live email account. The example environment selects a local capture inbox; follow the Mailpit setup below before creating an account.

Without DATABASE_URL, development persists embedded PostgreSQL under `.data/postgres`. One API process owns that directory. It is not a multi-process production database. Stop the API cleanly before backing up the development directory.

For standalone PostgreSQL, copy `.env.example` to `.env`, set DATABASE_URL, and restart the API. The API loads the root `.env` through Node's environment-file support. A local PostgreSQL service is defined in compose.yaml. Changing storage does not migrate existing development records between databases.

Set `API_INTERNAL_URL` in the web application's environment when the API runs on a different internal origin. For a production API, DATABASE_URL and an HTTPS WEB_ORIGIN are mandatory. Use a private network/reverse proxy, configure TLS and the runtime roles described below, and complete the remaining release gates before exposing the service to customers.

The interface currently uses “Orbit” as a provisional display name. The repository/package name remains AgentOrchestration.

## Delivered behavior

- Workspace creation, password hashing with scrypt, opaque hashed sessions, HttpOnly cookies, sign-in/out, mandatory email verification, and password recovery with session/credential revocation.
- Team invitations with transactional email delivery, resend/token rotation, single-use hashed tokens, expiry, revocation, new/existing account acceptance, member roles, suspension/restoration, last-owner protection, and workspace switching.
- Organizations above workspaces, DNS-verified domains, member-domain controls, regional assignment rules, versioned security policies, and separate organization ownership/administration.
- Profile and verified-email/password changes, device/session management, TOTP MFA and recovery codes, OIDC/SAML sign-in, and organization SCIM user/group provisioning.
- Explicit guest audiences, capability overrides, scoped expiring service credentials, organization/workspace ownership transfer, complete current-resource offboarding, and explicit restoration.
- An encrypted email outbox, leased background delivery, provider idempotency, bounded retries, sanitized failure codes, and delivery status in the team interface.
- Forced PostgreSQL row-level security, transaction-local tenant/role context, a tenant-bound worker, and separate migration/runtime credentials.
- Recipient-private notification inboxes with live badges, category preferences, conversation mute settings and source-authorized navigation.
- Session-bound, cross-instance online/away/invisible presence and scoped, expiring typing indicators without durable activity history.
- Tenant-scoped memberships, public/private channels, explicit private-channel membership and administrator-controlled creation.
- Unique person/person or person/agent direct messages and private groups, with group owners, participant management, role transfer, optimistic versions, and live access revocation.
- Private file attachments in messages and threads, upload progress/retry/cancellation, checksum validation, image previews, quotas, and leased cleanup.
- Durable plain-text messages, ordered channels/threads, request deduplication, guarded edits/deletion, reactions, persistent read receipts, and unread badges.
- Transactional outbox/audit records and resumable live updates over server-sent events, with opaque viewer-bound cursors and private-channel filtering. No separate realtime broker is required by this implementation.
- Advanced task management with nested subtasks, acyclic dependencies, calendar due dates, ownership, filtered/cursor-paginated lists, guarded transitions and human completion evidence.
- Live task comments with retry-safe creation, versioned edits, deletion tombstones, participant notifications and retained state history.
- Daily/weekly/monthly recurring tasks with advance creation, time zones, pause/resume, durable catch-up and independent occurrences.
- Due-date inbox reminders and a filtered month calendar with recurring previews and paginated schedules.
- Task-bound scanned file attachments with private downloads, image previews, live updates and guarded removal.
- Atomic, retry-safe bulk assignment/priority/due-date/state/organization changes and a paginated Kanban board.
- Audience-scoped projects, owned milestones with guarded completion and progress, and a versioned workspace label catalog with archive controls.
- External-agent identities, one-time-displayed bearer credentials stored hashed, pause/resume, explicit mention routing, a pending inbox and delivery acceptance.
- Collaborative knowledge editing, version conflicts, immutable revision history, snapshot comparison and restore, with conversation-scoped audiences.
- Advanced PostgreSQL full-text message/knowledge search with phrases, exclusions, filters, sorting, encrypted keyset cursors and current-access checks.
- Bidirectional message/thread history pagination with exact message jumps, preserved scroll position and live revalidation of older loaded content.
- Administrator activity view, structured API errors, Zod payload validation, security headers, mutation-origin checks, and request rate limits.
- Responsive web application, accessible native modal dialogs, keyboard search shortcut, retained message text after failed sends, and explicit empty/error states.
- PostgreSQL database adapter and a persistent embedded PostgreSQL development adapter sharing the same migrations and queries.

## Account and organization management

Account and organization management is documented in [identity setup, protocols, authorization, and lifecycle behavior](identity.md). Open **Settings & activity** for account/organization administration and **Team → Manage** for workspace access and offboarding. These controls work locally with Mailpit; a production IdP and regional infrastructure require operator configuration.

## Advanced task management

The Tasks screen now provides a filtered, paginated task list and a detail view for ownership, priority, calendar due date, nested subtasks, prerequisites, dependent work, discussion and state history. Filters cover title/description text, state, assignee or unassigned work, conversation/workspace audience, overdue tasks, and root tasks. Sort by creation time, due date or priority. Related-task pickers search and paginate within the same audience. Completing work requires explicit human verification evidence; the detail view exposes the attributed transition record.

### Ownership and source audiences

Every new task records its creator. Existing creators are backfilled from the earliest `task.created` audit event when available; an unknown historical creator stays null. The creator, current assignee, or a current human workspace owner/administrator may edit metadata, move work through permitted states, manage dependencies, or attach subtasks. Reading a task does not grant management rights. Active readers, including appropriately scoped agent identities, may add task comments. Only human actors may verify completion.

A task is either workspace-wide or bound to a conversation at creation. Its identity, creator and source audience are immutable. Subtasks inherit their parent's audience; moving a subtask and linking prerequisites requires an exact audience match, including workspace-wide versus conversation-scoped work. Different public conversations also count as different sources. This prevents an unreadable prerequisite from leaking through a title, progress count or blocked status, and keeps future group revocation consistent across the graph. Administrators cannot bypass private conversation access.

New assignments require active members who can access the source conversation. Existing departed/inactive assignees retain attribution until an authorized manager reassigns them; an unchanged old assignment does not prevent correcting other metadata. Role and membership changes are rechecked in the write transaction. Private task data, comments, notifications, pickers and state history become unavailable after source membership is removed. The client fences requests and clears open private task/editor/comment state on live revocation; denied reads also clear cached content.

### Graph and completion semantics

A subtask can have one parent and further descendants. Explicit dependencies are directed `task → prerequisite`; the completion graph also includes the implicit `parent → child` edges. A single cycle check therefore rejects pure hierarchy cycles, prerequisite cycles, and mixed cycles. Duplicate dependency additions/removals are safe set operations; successful graph changes advance the source task version once. The UI shows direct prerequisite/dependent lists and closed-subtask progress.

Prerequisites must be **completed** before a dependent task enters `active`, `awaiting_approval`, `awaiting_review` or `completed`. Queued/blocked/proposed work may retain unresolved prerequisites. A cancelled or failed prerequisite remains unresolved; managers must resolve, replace, remove or cancel the dependent work explicitly. Adding an unfinished prerequisite to work already in an executing/review/completed state is rejected. Move it back to a permitted blocked/queued state first when the state machine permits.

A parent may execute while its subtasks are in progress, but cannot complete or cancel until every direct child is completed or cancelled. Nested completion follows the same rule recursively. There is no implicit completion/cancellation cascade and no automatic restart of waiting tasks. Completion remains a human decision with evidence. Completed/cancelled tasks retain the existing terminal-state policy.

All graph writes take a workspace-scoped PostgreSQL advisory transaction lock before task row locks. Application writes first hold workspace authority, then the graph lock, current actor membership, source conversation and task rows; comment-only writes need no graph lock. This serializes reverse-edge insertion, reparenting and parent completion versus child creation across API instances. Database triggers enforce audience equality, graph acyclicity, blocker rules, stable identity and one-step metadata versions at commit, including trusted SQL/worker writes. Comment counter changes skip graph traversal. These transactions perform no network execution. Large graph imports and fleet contention remain load-qualification work.

### Task and graph APIs

- `GET /v1/tasks` preserves the compatible array interface, now with task creator, parent, due date and progress/comment counts, bounded to 200 rows.
- `GET /v1/tasks/list` returns `{items,next_cursor}`. Parameters: `q`, `state`, `assigneeId` or `unassigned=true`, `conversationId` or `workspaceOnly=true`, `parentId` or `roots=true`, `overdue=true`, `asOf`, `sort=newest|due|priority`, `limit` (1–100, default 30), and `cursor`.
- `POST /v1/tasks` accepts existing title/description/priority/assignee fields plus optional `conversationId`, `parentId`, `dueDate`, and `clientId`. It returns `{id,replayed}` with status 201 for creation or 200 for an identical retry. UI creation always supplies a stable attempt UUID; legacy clients may omit it. Retries compare the original normalized creation hash even after the task is edited. A changed payload under the same actor/request UUID returns `409 IDEMPOTENCY_CONFLICT`.
- `GET /v1/tasks/:id` returns `{task,parent,can_manage}`. Counts report direct subtasks, closed subtasks, dependencies, unresolved prerequisites and all discussion entries including tombstones.
- `PATCH /v1/tasks/:id` accepts expected `version` and any of `title`, `description`, `priority`, `assigneeId`, `dueDate`, or `parentId`. Null clears the optional assignment/date/parent. Actual metadata changes advance the version; unchanged current-version input is a no-op. Stale versions return `409 VERSION_CONFLICT` and the UI retains the draft for review.
- `GET /v1/tasks/:id/relations?kind=subtasks|dependencies|dependents&after=...&limit=...` returns `{items,next_after}` with UUID keyset navigation; limits are 1–100, default 30.
- `PUT /v1/tasks/:id/dependencies` accepts `{version,dependsOnId}`. `DELETE /v1/tasks/:id/dependencies/:target` accepts `{version}`. Both enforce source management/current access and return `{ok,version,replayed}`.
- `POST /v1/tasks/:id/transitions` retains `{state,version,evidence?}`. `GET /v1/tasks/:id/history?before=...&limit=...` returns descending transition records as `{items,next_before}`. `before` is an exclusive task-version boundary; metadata edits can leave gaps. Transition rows and human evidence are immutable to runtime/worker writes and protected by a database trigger.

`dueDate`/`asOf` are validated `YYYY-MM-DD` calendar dates with years 1–9999. A due date is overdue only when it precedes the comparison date and the task is not completed/cancelled. The browser sends its local calendar date; API clients omitting `asOf` get the current UTC date. Due dates have no time-of-day or implicit deadline timezone. Due/priority order uses indexed numeric sort keys followed by descending creation timestamp and UUID; cursor timestamps preserve PostgreSQL microseconds. Task cursors have independently derived keys, expire after 24 hours and authenticate viewer/workspace/filter/page-size bindings. Lists reflect live rows rather than an exported snapshot; live invalidations restart the current filtered list.

### Task discussion and notifications

`GET /v1/tasks/:id/comments?before=...&limit=...` returns `{items,next_before}`, descending by immutable per-task sequence; limits are 1–100, default 30. Bodies are plain text, 1–12,000 characters. `POST /v1/tasks/:id/comments` requires `{body,clientId}` and returns `{id,replayed}`. The original body fingerprint remains immutable so uncertain creation can retry safely after later edits/deletion. Identical concurrent requests allocate one sequence and produce one delivery.

`PATCH /v1/tasks/:id/comments/:comment` accepts `{body,version}` and is author-only. `DELETE` at that path accepts `{version}`; authors and current human administrators with source access may delete. Deletion clears text and leaves a tombstone. Stale edits/deletions return `409 VERSION_CONFLICT`; deleted comments cannot be edited or revived. The UI retains failed composer/edit drafts, requires review of a changed comment before resaving/deleting, and keeps loaded older comments during live refresh. These edits do not retain earlier plaintext bodies. Runtime/worker roles cannot hard-delete discussion rows, and SQL triggers preserve comment identity, retry hash and ordering.

Assignment and comment notifications use the existing Tasks preference and conversation mute rules. A new comment notifies active, authorized human creators, assignees and previous non-deleted participants, excluding its author. Notification excerpts read the current comment; deleting a comment or losing source access hides the notice. Reassignments use a separate assignment version so an old notice cannot reappear when someone is assigned again, while unrelated metadata edits preserve a valid assignment notice. Notifications navigate to the authorized task detail view. Domain changes, audit/outbox records and notification delivery commit atomically. Google/iCalendar synchronization is now implemented for assigned workspace tasks; see [work management](work-management.md). Task files, bulk actions and the Kanban board are described below.

## Projects, milestones and task labels

Open **Tasks → Projects** to create a project, choose an owner and audience, set status/start/target dates, and review progress. Open a project to manage milestones, their dates/status/descriptions and task counts. **View project tasks** and **View milestone tasks** open a filtered List. **Tasks → Labels** manages the workspace catalog, color, archive and restore. Task creation and detail include project/milestone/label choices; task badges appear in List and Kanban. List, Kanban and Calendar can filter by project, milestone and one label. Archived labels and closed projects remain available in filters. Select **Set project, milestone and labels** in bulk review to replace all three on tasks with the same audience; empty choices clear them.

### Access, placement and lifecycle

Projects have one immutable audience: the entire workspace or one conversation (including private channels, direct messages and groups). Tasks assigned to a project must have the exact same audience. Private source removal immediately denies project detail, milestones, task access, selectors and retry responses; client refresh clears denied project details and editors. A private project title or progress count is not exposed to readers outside its source. Label names are intentionally visible across the workspace, so the interface identifies them as workspace-wide metadata.

Active human project creators, current owners and human workspace owners/administrators with current source access manage project metadata and milestones. A new project owner must be an active human with source access. A departed owner retains historical attribution; the creator or an authorized administrator can maintain and reassign the project. Project ownership does not grant task editing. Existing task managers assign accessible work to projects, milestones and labels using the task version.

Project states are `planned`, `active`, `paused`, `completed` and `archived`. Paused projects still accept placement; paused is a planning state rather than an execution fence. Completed projects require every assigned task to be completed or cancelled. Archived projects may retain unfinished work. Completed and archived projects refuse new placement, including changing milestone placement while retaining that project. Existing task metadata and labels can still be maintained; clearing the project is permitted. Reopen a project to accept work. There is no hard deletion of projects, milestones or labels.

Milestones belong to exactly one project and use `planned`, `active`, `completed` and `cancelled` states. A completed milestone requires all assigned tasks to be completed or cancelled. Cancelled milestones can retain open tasks but refuse new placement. Reopen a closed milestone to add work. A project can complete with an empty or unfinished milestone definition if it has no open tasks; milestone definitions do not automatically change task states. Progress reports completed and cancelled counts separately. Overdue project counts use UTC and exclude closed tasks; the UI labels the timezone.

A task holds zero or one project and milestone; the milestone must belong to that project. Changing or clearing the project clears its milestone unless explicitly replaced. New subtasks inherit parent placement when omitted; labels do not inherit. A new task with a project but no explicit conversation derives the project's authorized source. Moving a task's source remains prohibited. Recurring occurrences copy the source task's current project/milestone and only active labels. A closed project or milestone pauses generation with an explanatory reason; an authorized human must review and resume. Calendar previews exclude closed placements.

### Label and write guarantees

Any active human member may create labels; only the creator or a human workspace administrator may edit/archive/restore them. Names are trimmed, 1–50 characters, case-insensitively unique across active and archived labels. Colors are the fixed `sage`, `blue`, `amber`, `rose`, `violet`, `slate` palette. The catalog supports 1,000 entries including archived labels. A task supports 20 unique labels. Archived labels retain current associations and can be removed, but cannot be newly assigned. Renaming/recoloring a label updates its current display everywhere without rewriting task versions. Changing task associations advances the task version once. A label set replacement, placement and other task changes in one bulk request are atomic.

Entity creation requires a UUID `clientId`; normalized payload fingerprints make unchanged retries safe, including concurrent delivery, while changed reuse returns `409 IDEMPOTENCY_CONFLICT`. Browser create forms retain request identity after uncertain responses and rotate it if input changes. Metadata updates require `version`; stale writes return `409 VERSION_CONFLICT` without replacing the draft. No-op writes with a current version do not increment it. Project/milestone completion and task placement serialize against concurrent writes with the workspace graph lock; deferred SQL checks defend completion invariants below the API. Domain updates and audience-scoped audit/outbox events commit together. Four new tables have forced tenant RLS, composite tenant references and restricted runtime/worker privileges. Migration 031 acquires the graph lock before direct SQL placement eligibility reads; migration 032 preserves the comment-counter path outside that lock to retain the existing lock order.

### Endpoints

- `GET/POST /v1/projects`, `GET/PATCH /v1/projects/:id`. Creation: `{clientId,name,description?,conversationId?,ownerId?,status?,startDate?,targetDate?}`. Updates accept the mutable fields plus `version`; audience is immutable. Detail returns `{project,can_manage}`. Names are 2–160 characters and descriptions up to 12,000. Dates are calendar dates in years 0001–9999; start cannot follow target.
- `GET/POST /v1/projects/:id/milestones`, `PATCH /v1/projects/:id/milestones/:milestone`. Creation: `{clientId,title,description?,status?,dueDate?}`; updates accept the mutable fields plus `version`. Title limits match project names. Completion fails with `409 MILESTONE_HAS_OPEN_TASKS` or `PROJECT_HAS_OPEN_TASKS` as appropriate.
- `GET/POST /v1/labels`, `PATCH /v1/labels/:id`. Creation: `{clientId,name,color?}`; update `{version,name?,color?,archived?}`. Lists include label author/version. Catalog lists return `{items,next_after}`, accept `after` UUID and `limit` 1–100 (default 30). Projects filter by `q`, `status`, `conversationId` or `workspaceOnly=true`; labels by `q` and `archived=false|true|all` (default false).
- Task create/update accepts `projectId`, `milestoneId` and `labelIds`; update accepts null placement IDs and an empty label array to clear. Bulk update patches accept the same fields. Task DTOs include placement IDs/names and current `{id,name,color,archived}` labels. Task lists add `projectId`, `milestoneId`, `labelId` and `noProject=true` (mutually exclusive with projectId); organization filter values bind the task cursor. Schedule lists accept project/milestone/label filters too.

Catalog UUID pagination orders by immutable ID and rechecks current access on every page. It is a live catalog rather than a historical snapshot; concurrent creates with lower UUIDs appear after a refresh. Task keyset paging preserves existing ordering/filter guarantees. Project reporting, planned task timelines, portfolio rollups and task/workflow templates are now delivered in [work management](work-management.md). Independent project membership/chat, critical-path dependency editing and broader project integrations remain separate full-product work. Production readiness still includes the release and operational gates below.

## Task attachments, bulk actions and Kanban

### Task attachments

The task detail screen includes **Task attachments**. Current task managers (creator, assignee or human administrator with source access) can upload, attach and remove files. Active readers can list/download attached files. Files use the existing private local/S3 storage, checksum validation, malware scanner, safe raster previews, storage quota, bounded upload concurrency and cleanup leases. The same 25 MiB per-file limit applies. Choose up to 10 files per upload batch; a task can retain up to 100 active attachments, with paginated listing.

Task reservations bind bytes to one immutable task and its exact audience, including workspace-only tasks. A task file cannot be moved to another task or attached to a message; conversation uploads cannot be repurposed as task attachments. The server rechecks active membership, current management rights and source access at reservation, upload claim, upload finalization and attachment/removal. There are no network/scanner calls under SQL locks. A change in assignment or private membership while an upload is running can reject its finalization. Pending uploads are private to their uploader; files become readable to the task’s audience only after attachment. No public object URLs are exposed.

Attachment creation locks the task and all selected files in stable order, validates every file before linking any, and commits links, file states and audit/live events together. Retrying the same attachment IDs does not create duplicate links or audit events. Attachment edits are separate from task metadata versions, so adding files does not invalidate a task draft or resend reminders. Files and attachment content are not automatically copied to recurring occurrences.

Removal requires the current attachment version, replaces the link with a retained removal record and immediately makes file downloads unavailable. A repeated removal is a no-op. A removed file cannot be reattached; upload a new copy instead. The existing leased cleanup worker deletes its bytes after the five-minute grace period and releases storage quota. Drafts and abandoned uploads continue to expire through the existing cleanup path. In-flight downloads cannot recall bytes already sent.

- `POST /v1/tasks/:id/files` reserves an upload with the existing `{clientId,name,size,sha256}` schema. The normal `PUT /v1/files/:id/content`, metadata, preview, download and discard APIs handle its bytes.
- `GET /v1/tasks/:id/attachments?after=...&limit=...` returns `{items,next_after}` with UUID keysets; limit 1–100, default 30. Items include file metadata, attachment actor/name/time and version.
- `POST /v1/tasks/:id/attachments` accepts `{fileIds}` with 1–10 distinct IDs, all ready/scanned, unexpired and uploaded by the actor for that task. Returns `{ok,replayed}`.
- `DELETE /v1/tasks/:id/attachments/:file` accepts `{version}` and returns `{ok,replayed}`. A stale live attachment returns `409 VERSION_CONFLICT`; trying to revive a removed link returns `410 ATTACHMENT_REMOVED`.
- Task responses include `attachment_count`. Private source ACLs are checked again in listing/download queries and on live refresh. The browser keeps failed upload drafts, supports retry/cancellation and recovers an uncertain attachment response using its existing file IDs.

### Bulk task actions

Select up to 50 explicitly loaded/manageable tasks in List or Kanban, then choose **Review bulk action**. Available changes are assignment/unassignment, priority, due-date setting/clearing, state transitions and project/milestone/label replacement. The review displays captured versions and current selection details; the user must acknowledge the selected tasks and intended change. Completion needs separate verification evidence for every task newly entering Completed. No shared completion text is silently applied across the selection.

Every batch is **atomic**. It verifies current management, source visibility and expected versions for all targets before mutation. Assignment checks each task’s audience. Metadata and transition changes reuse the same policy functions as individual edits. State transitions retain human evidence/history. Final dependency/hierarchy consistency is checked after all changes, allowing a parent and its children to be completed/cancelled together when the final graph is valid. Already-target states and identical metadata are no-ops. A conflict, forbidden target, missing evidence, invalid transition or unresolved dependency rolls back the complete batch, including history, notifications and outbox writes.

- `POST /v1/tasks/bulk/preview` accepts `{ids}` (1–50 distinct task IDs), rechecks current management/access and returns `{items}`. It does not mutate tasks.
- `POST /v1/tasks/bulk` accepts `{clientId,action,targets,...}`. `targets` contains 1–50 distinct `{id,version,evidence?}` entries. For `action=update`, provide a nonempty `patch` with `assigneeId` (UUID/null), `priority` or `dueDate` (calendar date/null), alone or combined. For `action=transition`, provide `state`; newly completed targets require their own nonempty evidence.
- Responses are `{items:[{id,version}],replayed}`. A tenant/actor/client ID ledger commits with the batch and binds a canonical request fingerprint. Concurrent retries and uncertain committed responses do not repeat changes, notifications or history; reusing an ID for different input returns `409 IDEMPOTENCY_CONFLICT`. Replay still requires current access and management of every target. Returned versions on replay describe the original committed batch, not subsequent edits.

The UI retains captured task versions when live updates arrive, so it cannot silently overwrite concurrent edits. After a conflict, **Review current task versions** reloads the selection; the user must acknowledge it again before applying. Selection resets when filters/view/detail scope changes and on authority revocation. It never selects hidden matches or silently runs across an entire workspace. These actions do not implement task hard deletion, bulk relationship changes or automatic external tool execution.

### Kanban board

**Tasks → Kanban** displays all nine canonical states. Columns query authorized task lists independently with 20-card pages, visible loaded counts (`20+` when more exist), per-column loading/errors/retry and explicit continuation buttons. Existing text, state, assignee, audience, overdue, hierarchy and sort filters apply. Sort order is canonical creation/due-date/priority order, not an unpersisted manual rank.

Cards show ownership, priority, due date/overdue status, subtasks, unresolved dependencies and file/comment counts. Open a card for task details. Desktop drag-and-drop changes state through the same versioned transition API; the **Move to…** select provides keyboard/touch access. Unsupported transitions and dependency/completion rules are enforced by the server. Completion opens the existing evidence dialog. Failed moves refresh canonical data instead of leaving an optimistic card in an invalid column. Live changes refresh columns; task content and selections are fenced by the existing workspace/authority lifecycle.

Migration 029 adds task-bound file identities, audience/source guards, forced-RLS attachment links with composite references, guarded soft-removal records and an append-only bulk request ledger. Runtime/worker roles cannot hard-delete attachment/ledger records or update ledger results. These changes extend the existing modular backend; they introduce no paid provider or new external service.

## Recurring tasks, reminders and calendar

Open a task’s **Recurrence and reminders** section to configure its schedule or due-date inbox reminder. Tasks now has **List**, **Calendar** and **Recurring** views. Existing tasks keep their behavior until scheduling is explicitly configured.

### Recurrence behavior

A current human creator, assignee or administrator with source access authorizes a daily, weekly or monthly schedule, an interval from 1–365, first due date, optional inclusive end date, IANA time zone, creation time and creation lead days (0–365). The editor defaults to a first new occurrence one week after the source due date (or one week after today when undated), created one day in advance; API clients omitting `leadDays` get zero. The source task remains separate, so choose a first new due date that does not duplicate its work. A weekly schedule stays on its anchor weekday. A monthly schedule clamps to shorter months and returns to the original anchor day afterward: January 31 → February 28 → March 31. Each local due date identifies one occurrence. Start/end dates support years 1–9999.

The worker creates a separate **proposed** task at the configured local time, `leadDays` days before its due date. It copies the source’s current title, description, priority, assignee, immutable conversation audience and reminder settings. It does not copy task relationships, discussion, state transitions or completion evidence. Source tasks and generated occurrences remain independent; completing/cancelling the source does not stop its schedule. Pause the schedule to stop future creation. Generated tasks link back to their source. Editing a generated task affects that occurrence; editing source metadata affects later occurrences.

Pause/resume retains the next occurrence. Changing frequency, interval or first date restarts calculation at the supplied anchor, while a unique recurrence/date ledger prevents duplicates for dates already generated. Extending an ended schedule resumes at its next calculated date. Changing a rule does not rewrite or delete existing tasks. Saving a schedule is explicit human reauthorization by the current manager; the worker rechecks that human’s active membership, current management rights and source access, plus assignee eligibility, before every occurrence. Lost authority/access pauses the rule with a visible reason. Fix the source assignment/access and have an authorized human review and resume it.

Scheduling shares PostgreSQL’s [documented handling of DST gaps and overlaps](https://www.postgresql.org/docs/current/datetime-invalid-input.html): nonexistent spring times move forward by the gap, and repeated fall times use the later standard-time interpretation. A local occurrence date is materialized only once. Dates are calculated from the original anchor rather than repeated month addition.

### Due-date reminders

Each task can have one configurable inbox reminder: 0–365 days before due, local time and IANA time zone. An enabled reminder requires a due date. It targets the current active human assignee, falling back to the creator only when unassigned; agent assignees do not receive human inbox reminders. The Tasks notification preference, global enabled setting and conversation mute apply. Suppressed deliveries are recorded and are not replayed merely because a preference is later enabled.

Reminders run every 30 seconds while the API is running. Work missed during downtime is caught up for open tasks. Set creation lead time early enough for advance reminders on recurring occurrences; if a task is created after its reminder time, the worker delivers it on the next eligible pass. Completed/cancelled work is excluded. Notifications resolve the current task title and permissions instead of copying task content. Due-date changes, reassignment, reminder changes/disabling, terminal states and revoked source access hide obsolete notices. Changing a due date or assignee starts a distinct delivery generation; unrelated metadata edits do not redeliver. Updating reminder settings also creates a new delivery generation and may deliver immediately if its time has passed.

These reminders are in-app inbox deliveries, not emails or browser push notifications. No live email account or external scheduler is required.

### Calendar and API contracts

The month calendar shows all-day task due dates and dashed future recurrence previews; previews open the source task and never create tasks on read. Assignee, audience and state filters respect current access. Future occurrences are proposed tasks for state filtering. Month navigation, a month picker and Today are available; the selected month survives opening a task. More entries are loaded explicitly, with a visible incomplete-calendar notice until all task/schedule pages are consumed. The Recurring view includes active, paused and ended rules with their next date, time zone and occurrence count.

- `GET /v1/tasks/:id/scheduling` returns `{recurrence,reminder,origin}` after task authorization. Missing configurations are null; generated tasks include their source ID/date.
- `PUT /v1/tasks/:id/recurrence` accepts `{version,frequency,interval,startDate,endDate,timeZone,localTime,leadDays?,paused}`. `localTime` is `HH:mm`; `frequency` is `daily|weekly|monthly`. Use version zero for first creation, otherwise the last returned recurrence version. All fields except leadDays are required. Recurrence versions also advance as the worker progresses.
- `PUT /v1/tasks/:id/reminder` accepts `{version,enabled,daysBefore,localTime,timeZone}` with the same zero/current-version convention. Source managers may change reminders.
- `GET /v1/task-schedules?after=...&limit=...` returns `{items,next_after}` with UUID keyset navigation; limit 1–100, default 30. Optional paired `from`/`through` dates enable bounded previews over at most 63 dates. Calendar queries exclude paused/ended/nonintersecting rules and already generated dates. Optional `assigneeId`, `conversationId` or `workspaceOnly=true` filter sources. A preview’s local time/time zone is its creation configuration, while the preview date is the task’s due date.
- `GET /v1/tasks/list` additionally accepts inclusive `dueFrom`/`dueThrough` dates, bound into its existing authenticated cursor. Undated tasks are excluded by a date-window filter.

Stale scheduling writes return `409 VERSION_CONFLICT`. Editors retain unsaved drafts and require cancelling/reopening to review current settings. These APIs reuse verified authentication, task management policy, conversation ACLs, strict contracts, audit history and live invalidations.

### Worker and database guarantees

Migrations 027–028 add forced-RLS recurrence, occurrence, reminder and delivery tables with composite tenant references. Runtime/worker roles cannot delete these records or change occurrence/delivery ledger entries. Schedule triggers enforce time-zone/minute validation and one-step versions. A task due-date generation changes only when its due date changes.

The tenant-bound worker starts with the API and stops cleanly during shutdown. All replicas take the workspace authority/graph locks before schedule writes, then current membership/conversation/task locks as appropriate. At most 50 catch-up occurrence advances and 100 reminder deliveries are processed per workspace per 30-second pass. A unique recurrence/date ledger and reminder/configuration/due-date/assignment identity prevent retry duplicates. Task creation or reminder delivery, its ledger record, notification, and outbox writes commit in one transaction. Database rollback cannot leave partially advanced schedules or partially delivered reminders. A workspace failure is logged, retried next pass, and does not stop processing other workspaces. There are no external calls under these locks.

This bounded scheduler needs backlog/latency and lock-contention qualification at fleet scale; worker uptime determines delivery latency. Business-day calendars and Google/iCalendar synchronization are now implemented in [work management](work-management.md). Arbitrary RRULE imports and email/push reminder transport remain separate capabilities.

## Search, history and knowledge editing

### Advanced search

The search screen supports messages and current knowledge pages, quoted phrases, uppercase `OR`, excluded terms such as `-draft`, conversation and author filters, local-calendar date ranges, attachment-only messages, main messages versus thread replies, and relevance/newest/oldest sorting. Empty terms allow browsing by filters. Knowledge author filtering refers to the page creator; revision history separately attributes every editor. Search snippets and page bodies remain plain text; user content is never rendered as HTML. The current language configuration is PostgreSQL `english`; semantic retrieval, OCR/file-body indexing, task search and multilingual language detection are not delivered by this endpoint.

`GET /v1/search/advanced` accepts `q` (up to 300 characters), `scope=messages|knowledge`, optional `conversationId`, `authorId`, `from`, `to`, `attachments=true`, `threads=main|replies`, `sort=relevance|newest|oldest`, `limit` (1–100, default 30), and `cursor`. Date parameters are ISO instants: `from` is inclusive and `to` exclusive. The browser converts its inclusive end calendar date to the following local midnight. Attachment/thread filters are rejected for knowledge searches.

Responses are `{items,next_cursor}`. Each hit contains an ID, a plain-text excerpt up to 600 characters, source conversation/thread, author, timestamp and version; knowledge hits include a title. Message results open their exact historical context, including replies. Knowledge hits open a fresh authorized page. Legacy `GET /v1/search?q=...` remains compatible with existing clients.

GIN indexes use the same full-text expressions as the queries. Keysets order relevance by rank/timestamp/UUID, newest by descending timestamp/UUID, and oldest by ascending timestamp/UUID, retaining PostgreSQL timestamp precision and rank serialization in the cursor. AES-GCM cursors use an independently derived key, expire after 24 hours, and authenticate the workspace, viewer and all filters (including page size). A cursor cannot confer access or change filters. Production uses the stable realtime cursor secret; unconfigured test/development app instances use an ephemeral key. Every page evaluates canonical current ACLs and excludes deleted messages. These are live-index pages, not an exported database snapshot: edits can change ranking or knowledge timestamps between requests. The UI deduplicates hits and restarts results on relevant live invalidations.

### Message history

`GET /v1/conversations/:id/messages/history` returns `{items,older,newer}` with chronological items. `older` and `newer` are exclusive sequence positions for the next `before` or `after` request, or null at that boundary. Requests accept at most one of `before`, `after`, or `around` (message UUID), optional `threadId`, and `limit` (1–100, default 50). Positions are positive 32-bit conversation sequences; they are navigation values, not credentials. Each request authenticates and checks current conversation access. A thread reference must identify a root in the same conversation; an anchor must belong to the requested timeline/thread.

An initial request reads the latest window. `before` reads the nearest older messages; `after` reads the nearest newer messages; `around` returns a balanced bounded context including the anchor. Tombstones retain ordering and can be anchored. Each message includes its current edits, deletion state, attachments, reactions, reply count and receipts. The existing array endpoint and its `before`/`around` parameters remain compatible.

The web client has independent older/newer controls for the conversation and open thread. It merges by message ID and immutable sequence, preserves scroll on prepending, and offers a return to the live conversation after an old-message jump. Revalidation covers the loaded range, so old edits, tombstones and receipts are refreshed without losing already loaded pages. Requests are aborted/fenced on scope changes and authority revocation. Each server request is bounded; large retained client windows require proportionally more revalidation requests, while measured timeline virtualization bounds mounted messages. Fleet-load qualification remains a performance release gate.

### Knowledge edits and revisions

Creation offers an explicit workspace or conversation audience. The page and every revision retain that source audience; current conversation membership governs discovery, search, details, snapshots, history, edits and restores. Workspace administrators do not bypass private audiences. Active human members who can read a page can collaboratively edit it. Agent edits/restores through these endpoints are rejected; the existing approved `save_knowledge` tool still creates its source-scoped page and initial revision atomically.

- `GET /v1/knowledge/:id` returns the fresh page, its creator and current editor names.
- `PATCH /v1/knowledge/:id` accepts `{version,title,body,summary?,clientId}`. Titles are 2–200 characters, bodies 1–50,000 characters and summaries at most 500 characters. The request body budget accommodates multibyte documents at that limit.
- `GET /v1/knowledge/:id/versions?before=...&limit=...` returns descending revision metadata as `{items,next_before}`; limits are 1–100, default 30. Full bodies are fetched only for a selected snapshot.
- `GET /v1/knowledge/:id/versions/:version` returns a historical title/body and editor/timestamp/summary/restore provenance.
- `POST /v1/knowledge/:id/restore` accepts `{version,targetVersion,summary?,clientId}` and appends the selected text as a new current revision.

Both mutations return `{page,applied_version,replayed}`. `version` is the expected current version; `clientId` is a UUID unique to that attempted change. Concurrent writers serialize on the page; a stale base returns `409 VERSION_CONFLICT` without changing current content or history. Identical retries by the same actor return the current page and the originally applied revision, even if newer revisions have since been published. Reusing the identifier for a different payload/actor returns `409 IDEMPOTENCY_CONFLICT`. Explicit saves create an attributed revision even if the text is unchanged.

Page update, append-only snapshot, audit and realtime invalidation share one transaction. Lock ordering preserves compatibility with team/group authority changes. Database triggers enforce one-step version advancement, stable identity/creator/audience and a matching current snapshot at commit. Revision updates/deletes are denied to runtime/worker roles and rejected by an immutability trigger. Restores retain all later history. These history APIs do not implement a retention purge or page hard deletion.

The editor keeps its draft during failures and live concurrent changes, displays the latest saved text for review, and requires explicit acknowledgement before rebasing a conflicting draft. An uncertain save can retry the original operation without creating another revision. Version history is paginated, attributes each author and summary, compares a snapshot and the current page side by side, and explains the new version produced by restore. Drafts stay in component memory, are not placed in browser persistent storage, and are cleared on access revocation. Leaving the editor discards an unsaved draft.

## Notifications, presence and typing

The sidebar **Notifications** inbox shows recipient-private, persistent in-app notifications for direct/group messages, human mentions, thread replies, reactions, group additions, assigned tasks and actionable approval requests. Notification creation runs in the source transaction; a rollback cannot leave a notification without its message/action. Repeated message requests and reactions do not duplicate deliveries. Group additions use conversation/version-aware delivery identities so invitations in different groups and later re-invitations remain distinct.

Ordinary channels notify mentions and thread participants by default. Direct/group conversations notify messages by default. A reply notifies the root author and earlier participants in that thread, never its own author; a mention takes precedence, so one message produces at most one notification per recipient. Reactions notify the message author once per reacting person/message; removing that person's remaining reactions hides the notice. Assignments notify the current human assignee; approvals notify current human workspace administrators who can access the source conversation. Administrative roles do not bypass private audiences. Group additions notify the added person. Self-notifications and agent inboxes are excluded.

The composer has a permission-filtered mention picker and transmits explicit member IDs to disambiguate duplicate display names. Plain-text `@Display Name` mentions resolve only when the active, eligible display name is unique, with token boundaries rather than substring matching. Cross-tenant/private targets, missing visible mention text and over 50 targets are rejected. Edits do not send new mention notifications. Original explicit mention IDs are included in message creation fingerprints, preserving retry identity after edits/deletion.

The inbox supports unread counts, read/unread controls, cursor pagination and **Mark all read** through the newest displayed item. Notifications arriving after that cutoff stay unread. Message read positions acknowledge message/mention/reply notifications in the same timeline/thread, without acknowledging unopened replies. Category preferences and per-conversation **Default**, **All messages**, **Mentions and replies** and **Muted** settings affect new deliveries. Disabling notifications does not erase existing inbox history or channel unread counts. Explicit all-message mode overrides the default conversation message category; mute and the global enabled switch take precedence.

Notification rows store source identities and delivery state, never copied message bodies or attachment contents. Inbox excerpts, unread counts and navigation recheck current source permissions. Deleted messages, inaccessible groups, removed reactions, reassigned tasks and settled approvals disappear from authorized results. Read mutations are recipient-bound. Inbox changes use audience-targeted durable invalidations; another person cannot subscribe to them. Client invalidation fences pending page/navigation responses after revocation. Opening an old notification fetches its exact conversation/thread context using bounded index-backed history windows, with a return-to-latest control.

### Presence and typing behavior

Presence offers **Automatic**, **Away** and **Invisible**, saved per workspace member. Automatic status is online when any live browser client is active, away when all live clients are away, and offline when none remains. The browser considers a hidden/unfocused tab or five minutes without keyboard/pointer input away. It heartbeats every 20 seconds, plus focus/visibility/network transitions; leases expire after 60 seconds. Multiple tabs and independent sessions aggregate. Leaving a tab attempts a client-specific release, but correctness depends on expiry, not successful unload requests. Leases reference the actual hashed authenticated session through a composite foreign key and cascade when it is revoked; an expired login or suspended member cannot remain online. Invisible clients appear offline to others and do not publish typing. No historical last-seen timeline is collected.

Typing is a single active conversation/thread scope per browser client. Updates contain only identifiers, a monotonically increasing revision and a start/stop flag—never draft text, keystrokes or cursor positions. The composer throttles starts to one every two seconds and stops after 2.5 seconds without input, blur, send, unmount or visibility changes. A lost stop expires after eight seconds on the server. Out-of-order updates cannot revive an earlier revision, and a delayed stop for one scope does not clear typing in another. Only active browser sessions can type; thread IDs must name a root in that conversation. Both the typist's and viewer's current private-conversation access are checked on every snapshot. UI typing indicators also expire locally during disconnects.

PostgreSQL lease tables support multiple API instances without process-local presence truth. Human SSE clients receive an `activity` snapshot about every two seconds on the existing authenticated stream; these frames do not advance durable event cursors. Each snapshot is capped at 1,000 online/away members and 100 accessible typing scopes. Presence contains no current-conversation or last-seen fields. Typing scope identifiers are returned only for conversations the viewer can access. Activity never enters durable outbox/audit history. A tenant-bound cleanup worker removes expired rows every minute; reads already exclude them. Per-member advisory admission locks avoid reversing messaging's conversation/member row lock order. Admission is capped at 32 live browser clients per member. These database/snapshot bounds and existing stream/rate limits require workload qualification before large-fleet use; dedicated ephemeral fan-out remains a future scaling option.

### Added notification/activity APIs

- `GET /v1/notifications?unread=true&before=<notification-id>&limit=30` lists authorized inbox items and counts; cursors belong to the recipient.
- `PATCH /v1/notifications/:id` accepts `{read:boolean}`; `POST /v1/notifications/read-all` accepts `{throughId}`.
- `GET/PATCH /v1/notifications/preferences` reads or selectively updates category preferences.
- `GET/PUT /v1/conversations/:id/notification-preferences` reads/sets conversation delivery mode.
- `GET /v1/conversations/:id/mentionable-members` lists eligible mention targets. Message creation accepts optional `mentionIds`.
- `GET /v1/messages/:id/context` and `GET /v1/conversations/:id/messages?around=<message-id>` locate older messages without scanning an unbounded result set. `before` and `around` are mutually exclusive.
- `GET /v1/activity` returns the current authorized activity snapshot.
- `PUT /v1/presence` accepts `{clientId,revision,state}`; `DELETE` releases that authenticated session/client.
- `PUT /v1/presence/preferences` accepts `{mode}`.
- `PUT /v1/conversations/:id/typing` accepts `{clientId,revision,active,threadId?}`.

No new cloud account or credentials are required for these features. This slice delivers in-app notifications while signed in, with durable unread state across reconnects. Web/mobile push, OS/browser desktop delivery, notification email/digests, scheduled quiet hours, conversation-follow controls beyond participation, large-workspace presence pagination and analytics/retention administration remain full-product work. Presence indicates a client heartbeat, not proof that a person is available or reading.

## Direct messages, private groups and attachments

Use the **New conversation** button beside **DIRECT & GROUP MESSAGES**. Direct messages are unique per unordered member pair, including human/agent pairs; concurrent requests from either side reuse the same conversation. Direct participants cannot change. Human messages to a direct agent wake its inbox without an explicit mention; group messages still require mentions. Agents cannot initiate or administer these conversations.

Private groups support 2–50 initial participants. Their creator is a group owner, independently of workspace roles. Group owners can rename groups, add/remove participants, and promote/demote other active people. Participants can leave; the last owner must transfer authority before leaving others behind or demoting themselves. The final participant may leave an empty, inaccessible group. Workspace administrator status does not grant access to another person's DM or group. **Current group policy grants newly added participants retained history and existing files.** The UI discloses this before creation and addition. Configurable history cutoffs and unanimous consent remain target release work; sensitive groups should start a new conversation instead of adding participants.

Group edits require the current version. Membership changes fence all pending/running/approval-waiting runs and approvals in the source conversation before modifying its audience. Admission is excluded with a workspace SHARE lock, then existing runs are locked in ID order before the conversation; no database transaction waits on network execution. Revoked participants lose access to messages, search, edits, reactions, receipts and files. A viewer-specific invalidation clears the removed participant's current UI without exposing that notification to other members. Audit activity applies the same conversation/audience filters.

The composer accepts up to ten non-empty files of up to 25 MiB each, with or without text, including thread replies. Upload reservations bind workspace, conversation, uploader, expected bytes/checksum, provider and a server-generated object key. Reservations are idempotent; a content PUT has a single fenced attempt. The API streams one multipart file to a private temporary directory, checks the exact size and SHA-256, scans it, detects its content signature, and optionally regenerates a bounded PNG preview. Multipart file/field/part limits are explicit. Upload work has a two-minute deadline, with at most four active uploads per API process and two per member; these are process limits. The browser retains failed drafts, supports retry/removal, and recovers a successful upload when its response was lost.

Only a file's uploader can inspect or download it before sending. Message creation atomically binds ready files uploaded by that author in that same conversation. Composite foreign keys prevent cross-tenant or cross-conversation links; ordered attachment fingerprints make uncertain message retries safe after edits/deletion. A deferred database constraint prevents empty live messages with no attachment. Existing messages retain their default empty attachment fingerprint.

Downloads and previews require a current authenticated conversation participant. Originals use `application/octet-stream`, attachment disposition, no sniffing, and a restrictive CSP; user HTML/SVG is never rendered inline. PNG/JPEG/WebP/GIF previews are decoded with a 16-million-pixel limit, oriented, stripped of metadata, resized to at most 640×480, and emitted as PNG only when under 512 KiB. Storage keys, bucket names and signed/public object URLs are not returned to clients. Message deletion denies downloads immediately and schedules physical cleanup. Other participants retain attached files when their uploader leaves; abandoned unbound uploads from removed members are discarded.

### Storage configuration and operation

Local development needs no cloud credentials: originals/previews live in private `.data/files`, staging files in `.data/uploads`, outside the web root. Without `CLAMAV_HOST`, development explicitly records `development_only`; no malware-clean claim is made. This bypass cannot be selected by production server configuration. Production requires `FILE_STORAGE_PROVIDER=s3` (or its production default), `S3_BUCKET`, `S3_REGION` and `CLAMAV_HOST`; `CLAMAV_PORT` defaults to 3310. An optional `S3_ENDPOINT` supports compatible storage and must use HTTPS in production. Use the AWS SDK credential chain, preferably a workload identity/IAM role, with GetObject/PutObject/DeleteObject permissions scoped to the private bucket. Enable Block Public Access, transport encryption, encryption at rest, and appropriate region/lifecycle/retention policies on that bucket. The SDK performs no bucket provisioning. Keep ClamAV private, signatures current, and its stream limit above 25 MiB. A scanner outage rejects uploads rather than publishing unscanned files.

Workspace storage defaults to 5 GiB. Reservation and quota changes serialize on the workspace row; reserve original size plus bounded preview overhead, then reduce the reservation to the stored bytes. A maximum of thirty outstanding reservations per uploader also bounds abandoned small files. Unsent uploads expire after 24 hours. Cleanup claims records using tenant-bound leases and SKIP LOCKED, removes original and deterministic preview keys outside the transaction, then releases quota exactly once. Failed deletes retry; deleted objects are rechecked daily for seven days to catch uncertain late provider writes. Abandoned upload leases expire after ten minutes, beyond the upload deadline; deletion has a five-minute grace. Staging directories left by a process crash are swept after 24 hours. Back up metadata and objects together. Changing providers does not migrate existing objects or reroute cleanup for another provider.

Reverse proxies must accept at least 26 MiB multipart bodies and permit the two-minute upload deadline. Next's proxy buffer is configured to 26 MiB and its upstream timeout to 125 seconds; the API still enforces 25 MiB per file. External infrastructure limits need qualification, particularly platforms with smaller function ingress limits. Downloads use authenticated streaming rather than public object links. File editing/version history, resumable chunked uploads, range downloads, bucket migrations, DLP, per-file sharing links and retention/legal-hold policies remain full-product work.

### Added APIs

- `POST /v1/conversations/direct` and `/v1/conversations/groups` create/open private conversations.
- `GET /v1/conversations/:id` returns participant details; `PATCH` applies a versioned group rename or participant change. The channel member endpoint rejects DM/group modifications.
- `POST /v1/conversations/:id/files` reserves a file; `PUT /v1/files/:id/content` uploads one multipart file.
- `GET /v1/files/:id` returns authorized upload metadata; `DELETE` discards an unbound upload.
- `GET /v1/files/:id/content` and `/preview` authorize and stream private content.
- Message creation accepts `attachmentIds` in display order; list responses include attachment metadata.

## Live messaging, edits, reactions and read receipts

The web client opens one authenticated SSE connection per workspace session through `GET /v1/events/stream`. Message, reaction and read-state changes update other connected clients without a page reload. Streams carry references, never message bodies. The client coalesces invalidations, fetches only relevant authorized snapshots, retries failed refreshes, and resynchronizes after reconnect, focus or network recovery. The footer shows connection state. Scrolling follows new messages when already at the bottom; a jump button appears while reading older messages.

Message authors can edit their own live messages. Authors and human workspace administrators can delete messages they can access; administrative status never bypasses private-channel access. Both operations require a displayed `version`, and concurrent changes return `409 VERSION_CONFLICT`. Edit drafts survive failed saves. A delete confirmation becomes invalid if the message changes while it is open. Deletion clears the current body and reactions, removes pending external-agent inbox deliveries, and leaves a tombstone so thread replies and ordering remain intact. Deleted content is excluded from search, fresh agent context and pending inbox reads. No plaintext edit history is retained. Already dispatched agent input, prior exports and backups are outside this deletion operation.

Creation idempotency uses an immutable SHA-256 fingerprint of the original submitted body, an immutable fingerprint of the ordered attachment IDs, plus author/client/conversation/thread identity. Retrying the same creation request after an edit or deletion returns its original message ID and cannot restore old text. The composer reuses the client request ID after an uncertain network failure when retrying the unchanged draft. Edits do not dispatch new agent mentions; initial explicit mentions retain their original routing semantics.

Reactions use a shared twelve-emoji catalog. `PUT` adds the caller's reaction and `DELETE` removes only that caller's reaction. Unique composite keys and a message lock make retries/concurrent requests safe. Counts include active members; the current viewer's reaction is marked separately. Deleted messages cannot acquire new reactions.

Read positions are monotonic and scoped independently to the channel timeline and each thread. Opening a channel does not mark unopened thread replies as read. The browser reports visible message ends only while the document is visible and focused; writes are coalesced and retried. Advancing a position acknowledges earlier messages in that same scope. This records the client's acknowledgement, not proof that a person comprehended the text. Authors see human reader names/counts, with the returned name list capped at twenty. Agent credentials cannot submit human read receipts. Unread counts exclude the viewer's own messages and deleted text and persist across sessions.

All new workspace tables use forced RLS and composite tenant references. Mutations recheck active membership and permissions inside their transaction, using a lock order compatible with team authority changes. State changes commit with audit/outbox records; duplicate reactions and stale/backward read updates do not create new events.

### Event publication and operation

Publication assigns a contiguous workspace sequence to committed outbox rows while holding a separate `realtime_heads` lock. Source identity IDs can commit out of order; they are never used as resume positions. Several API processes can publish the same workspace safely. The published position commits atomically with the head update, so rollback cannot leave a visible cursor ahead of an unpublished event. Historical outbox rows are published lazily as subscribers connect.

Public event IDs are opaque HMAC values. Resume cursors use AES-GCM with the workspace/member as authenticated audience; another member or tenant cannot reuse them. Private events are filtered before delivery. SSE sends hidden-event checkpoints on a fixed fifteen-second cadence rather than announcing each hidden change. Treat cursors as opaque strings, not numbers. `Last-Event-ID` takes precedence over an optional `after` query parameter. `GET /v1/events?after=...` remains a bounded HTTP replay interface using the same cursor format; old numeric cursors must be discarded and resynchronized from `0`.

Set an optional canonical 32-byte base64 `REALTIME_CURSOR_KEY`, stable across replicas and restarts. If unset, the server derives independently labeled cursor and event keys from `EMAIL_ENCRYPTION_KEY`. Production app construction requires stable key material. Test/unconfigured development app instances can use an ephemeral process key; restart then requires a fresh snapshot. Key rotation similarly forces resynchronization. Cursor possession never substitutes for authentication.

Active SSE subscribers check committed changes about every 500 ms; short publication work is coalesced per workspace within one API instance, and PostgreSQL coordinates publishers across instances. Authentication is rechecked between batches, so sign-out, suspension, password recovery, and credential revocation close old streams. Batches contain at most 100 events. Streams use bounded Node stream backpressure, have a five-minute connection lifetime, and release subscriptions/timers on disconnect or server shutdown. Each API process admits at most four connections per workspace member and 256 overall. These are process limits, not fleet-wide quotas. The general API budget is 600 requests per IP/minute; sign-in, signup, verification and recovery retain their stricter route limits.

Production reverse proxies must forward event-stream bytes promptly, disable response buffering/compression that delays small frames, support long-lived responses, and preserve cookies and `Last-Event-ID`. Browser tests verify unbuffered stream delivery to isolated APIs; qualify the deployed reverse proxy separately. SSE publication uses database polling inside the backend; Redis/broker fan-out, fleet-wide admission/rate limits, durable consumer acknowledgements, event retention and large-load/failover qualification remain operational work. The UI initially loads the latest 100 messages per timeline/thread and supports older/newer pages and anchor navigation as described above. Encrypted offline composition and permission-checked replay are now implemented as described in [messaging implementation](messaging.md).

Delivered endpoints: `PATCH/DELETE /v1/messages/:id`, `PUT/DELETE /v1/messages/:id/reactions`, `PUT /v1/conversations/:id/read`, `GET /v1/events`, and `GET /v1/events/stream`, alongside existing conversation/message endpoints. Edits require `{body,version}`, deletion requires `{version}`, reactions require `{emoji}`, and reads require `{messageId}`.

## Team invitations and membership

Open **Team** to invite people and manage human members. Owners can invite administrators or members; administrators can invite and manage ordinary members. Only an owner can change owner/administrator access or grant ownership. Changes require the displayed member version and recheck the acting administrator inside a workspace-locked transaction. The last active owner cannot be demoted or suspended. Promote another person before transferring ownership.

Invitation creation returns a private link once. Tokens contain 256 bits of randomness; only their SHA-256 hashes are stored. Links expire after seven days and can be revoked. Creation atomically queues an invitation email. The interface also displays the private link once. A pending invite can be resent after a one-minute cooldown; resend rotates the token, extends expiry to seven days, and cancels old queued delivery. Revocation invalidates the link and cancels unsent delivery. Expired pending invites are replaced on creation. Provider acceptance is shown separately from invitation acceptance; it is not proof of inbox delivery.

The link puts the token in a URL fragment, which browsers do not send in HTTP requests. The invitation page removes it from browser history and submits it in a POST body. Preview exposes only the workspace name, role and masked email. A new person supplies a name/password; the invitation fixes their account email and workspace role, then queues a separate verification email. Invitation creators can see the invitation token, so accepting it alone does not prove mailbox ownership. An existing person signs in with the matching email. Acceptance rechecks expiry, status and the inviter's current authority under a workspace lock, consumes the invitation, creates the membership/session, and writes audit/outbox events in one transaction. Concurrent acceptance creates at most one membership. Reopen the original link if the acceptance page is reloaded before completion; the token is deliberately not stored in browser storage.

Suspension deletes the person's sessions for that workspace and fences their queued, running, approval-waiting and uncertain managed runs plus unexecuted proposals. Role changes also fence open runs to prevent old authority from being reused. Execution rechecks the current active requester and approver before any action. This prevents publication and database tool writes after the fence; an already-running model call may continue until its observation timeout. History and attribution remain intact. Restoration requires a new sign-in; deleted sessions are not restored. Suspended people cannot bypass this through a replacement invitation, and cannot receive new assignments or channel grants.

People with several active memberships can switch workspaces from **Team** or organization settings. Switching verifies the destination's current membership and identity policies, rotates the session, and invalidates the previous session. Agent credentials cannot use human workspace switching. An account without an active workspace can sign in to its own account, create an organization or accept a different invitation; that account-only session cannot read tenant content or restore suspended membership.

Delivered endpoints: `GET /v1/members`, `PATCH /v1/members/:id`, `GET/POST /v1/invitations`, `POST /v1/invitations/:id/revoke`, `POST /v1/invitations/preview`, `POST /v1/invitations/accept`, `GET /v1/workspaces`, and `POST /v1/workspaces/switch`. Member update payloads require `version` and a role or status change.

## Transactional email, verification and recovery

### Local inbox without live delivery

The explicit `mailpit` provider captures messages on your machine. Verification, recovery and invitation links follow the same encrypted outbox and delivery-worker paths as live email; verification still requires following the captured link. Local capture does not prove ownership of a real external address. Nothing is forwarded to Gmail or other external recipients. This mode requires `NODE_ENV=development` or `test` and is rejected in production, including when injecting a provider directly into the app.

```sh
# First-time setup only; preserve an existing .env and encryption key.
cp .env.example .env
openssl rand -base64 32
# Save the generated value privately as EMAIL_ENCRYPTION_KEY in .env.
# Keep NODE_ENV=development and EMAIL_PROVIDER=mailpit.
npm run email:dev
npm run email:verify
npm run dev
```

Open [the app](http://localhost:3000), create an account, then open [the local inbox](http://localhost:8025) and follow the verification link. The verification screen also links to the inbox. Any syntactically valid email address can be used locally; messages are captured rather than sent to that address. Recovery and invitation emails appear in the same inbox.

`compose.mail.yaml` runs pinned [Mailpit](https://mailpit.axllent.org/docs/install/docker/) independently of the PostgreSQL service. SMTP (`1025`) and the inbox (`8025`) bind only to host loopback; no relay or forwarding is configured. The API connects only to `127.0.0.1:1025`, without credentials. The volume retains up to 500 local messages across restarts; they contain actionable links, so keep the inbox on your development machine. `npm run email:stop` stops it while preserving its data. Restart with `npm run email:dev`. If it is unavailable, sends fail explicitly; there is no automatic live-provider fallback.

### Live delivery configuration

Live email supports a temporary personal Gmail sender and Resend for a verified domain. Set the following **server-only** values in the API environment (the root `.env` for local development):

- `EMAIL_PROVIDER`: `mailpit` locally, or `gmail` or `resend` for live sending. An unset value defaults to `resend` for existing deployments.
- `GMAIL_USER` and `GMAIL_APP_PASSWORD`: for Gmail, your personal Gmail address and its Google app password. The normal Google account password is not supported.
- `RESEND_API_KEY`: for Resend, a sending-enabled key from the approved account/integration.
- `EMAIL_FROM`: for Gmail, must match `GMAIL_USER` and defaults to `Orbit <GMAIL_USER>`; for Resend, use an address on a domain verified in that account.
- `EMAIL_ENCRYPTION_KEY`: a stable canonical base64 encoding of 32 random bytes. Generate privately with `openssl rand -base64 32`. Use the same value on every API/mail-worker replica. This key protects queued email payloads, which temporarily contain actionable links.
- `WEB_ORIGIN`: the trusted HTTPS application origin used to construct email links. Local development permits loopback HTTP only. Request Host headers never determine link destinations.

For Gmail, enable 2-Step Verification and generate a dedicated [Google app password](https://myaccount.google.com/apppasswords). Save it privately in `GMAIL_APP_PASSWORD` in the ignored `.env` file. Google may restrict app-password availability for some account/security configurations. App passwords can be revoked independently; changing the Google account password also revokes them. Gmail is a temporary, low-volume sending option subject to Google's account quotas and abuse controls. Move to a verified domain/provider before a broad customer rollout.

```sh
# After saving Gmail configuration in .env:
npm run email:verify
npm run dev
```

`email:verify` checks local SMTP connectivity in Mailpit mode, or authenticates to Gmail in Gmail mode, without sending a message or printing credentials. Restart the API after changing its environment file. It does not make Google account changes or provision Resend. A successful authentication check does not guarantee inbox delivery. Never paste app passwords into chat or commit them.

Gmail connects only to `smtp.gmail.com:465` using TLS with certificate verification, bounded connection/socket timeouts, disabled protocol logging and disabled file/URL content access. The SMTP envelope and From address are bound to the authenticated account. Stable Message-IDs provide correlation, not duplicate-delivery protection. Gmail cannot send using another arbitrary From address through this configuration.

For Resend, provision/approve the integration and verify the sending domain through the provider's account setup. No real credentials are included in tracked repository files. Development can start without email configuration, but signup, invitations and new verification/recovery requests fail explicitly with `EMAIL_UNAVAILABLE`; there is no console-mailbox or fake-success production fallback. Production startup requires complete email configuration. Existing sessions for accounts without verified addresses are restricted to the verification flow. Existing accounts are deliberately **not** backfilled as verified: they must request verification or use recovery to prove mailbox ownership.

Signup commits the account, workspace, restricted session, verification proof and encrypted delivery job together. An unverified session can check its status, request another email or sign out, but cannot enter the workspace API. Verification tokens expire after 24 hours; recovery tokens expire after 30 minutes. Both contain 256 random bits, are stored hashed, are bound to one purpose, and can be consumed once. Issuing a replacement invalidates the old proof. Token checks and consumption serialize on the account row. A recovery email sent to an unverified account can also establish mailbox ownership when the password is reset.

Verification/recovery request endpoints always return the same 202 body for eligible, unknown, already-verified or cooldown-limited addresses. They use per-IP limits, a durable one-minute per-account/purpose cooldown and a common response-time floor with jitter. The timing floor masks normal query/queue differences; it is not a formal constant-time guarantee during database stalls. Confirmation endpoints have separate rate limits. All API responses use `Cache-Control: no-store`.

Password reset updates the scrypt hash, increments the account's credential version, deletes **all** human sessions for that account across workspaces, and consumes all outstanding account proofs in one transaction. It does not sign the person in automatically or restore suspended memberships. Sign-in rechecks its credential version while creating a session, preventing an old password check from creating a session after a concurrent reset. Existing managed runs and approvals snapshot the requester's/approver's credential version; they cannot publish or execute under a superseded credential version. External agent bearer credentials remain separate and require their existing agent revocation controls.

Email URLs carry secrets in fragments, not query strings. Browser pages remove the fragment from history and hold it only in memory. GET requests never consume links; a user must explicitly confirm verification or submit a new password. Password forms wait for hydration and use POST as their native HTML fallback. Reopen the original email link if the page is reloaded before completion. There is no token endpoint or mailbox viewer in the production app.

`EmailWorker` uses database leases with `FOR UPDATE SKIP LOCKED`, one-minute lease expiry and fenced completion updates. Every job snapshots its provider and idempotency policy; changing `EMAIL_PROVIDER` never silently reroutes pending messages through another provider. Drain pending jobs before switching, or request replacement links under the new provider. Each job's fully rendered message is AES-256-GCM encrypted with its job ID as authenticated data. With Resend, retries reuse the same message and `orbit-email/<job-id>` provider idempotency key. Requests go only to `https://api.resend.com/emails`, reject redirects and have a ten-second timeout. Transport uncertainty, 429, 409 and provider 5xx failures retry with bounded exponential backoff/jitter, up to eight attempts. Other provider errors fail permanently. Provider response bodies are not logged or exposed.

With Gmail or Mailpit, explicit temporary SMTP rejections can retry with bounded backoff; permanent rejection/authentication errors fail. A connection loss, unknown send outcome, failed completion commit after sending or expired in-flight SMTP lease becomes `outcome_unknown` and is **never automatically resent**. The worker erases the encrypted payload in this state. An expired lease is treated conservatively even if the process may have crashed before submission. The invitation UI shows uncertain delivery; resend rotates the token and creates a fresh email. Verification/recovery requests similarly replace the proof after the cooldown. Because SMTP does not supply an idempotent send API, the application cannot guarantee exactly-once SMTP delivery; this policy prevents automatic replay of an uncertain attempt.

Recovery delivery stops after 30 minutes; other delivery stops after 23 hours, before Resend's documented 24-hour idempotency window ends. Expired proofs and revoked/consumed invitations are cancelled before sending. The worker erases ciphertext on provider acceptance, cancellation, permanent failure, uncertain SMTP outcome or deadline expiry. A send already in flight cannot be recalled; invalidated links remain unusable. An old process can still finish its network call after lease loss, but stable provider idempotency prevents another delivery within the retry window and lease fencing prevents stale database completion. Provider acceptance is not a bounce/delivery receipt; webhook-based delivery, complaint and bounce processing remain future work.

Keep the encryption key stable while jobs are queued. Drain or intentionally cancel pending jobs before key rotation; losing the key makes those messages unrecoverable. Terminal job metadata and identity security events are retained; automated retention/erasure policy remains release work. Email processing currently shares the trusted identity process/role, though each worker is independently lease-safe. Production multi-replica operation and live account/provider activation still need operator qualification.

Endpoints: `GET /v1/auth/status`, `POST /v1/auth/verification/request`, `POST /v1/auth/verification/confirm`, `POST /v1/auth/password/forgot`, `POST /v1/auth/password/reset`, and `POST /v1/invitations/:id/resend`. Browser routes: `/sign-in`, `/forgot-password`, `/verify-email`, and `/reset-password`.

References: [Google app-password setup](https://support.google.com/accounts/answer/185833), [Nodemailer SMTP transport](https://nodemailer.com/smtp), [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), and [OWASP recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Database isolation and production credentials

Every workspace-bearing table has enabled and forced RLS, including the email outbox. Global account tokens and identity security events have forced identity-only RLS. Tenant SQL cannot read encrypted mail payloads, account proofs, or global identity security events. A narrowly scoped SECURITY DEFINER function exposes only a tenant-bound human’s current credential version and verification state to run/approval policy; it uses a fixed search path, locks the account and has no PUBLIC execute grant. `workspaces` is protected by its ID; knowledge versions and sessions carry backfilled workspace IDs and composite foreign keys. Session constraints bind the account, membership and workspace together. Existing private-channel authorization remains in application policy; a same-workspace SQL scope alone does not enforce private-channel access.

`scopedDatabase` is the mandatory application adapter. It wraps each query or explicit transaction, sets an allowlisted role with `SET LOCAL ROLE`, and sets `ao.workspace_id` with transaction-local `set_config` on that same connection. Context expires on commit/rollback. Request scopes use AsyncLocalStorage and resolve tenant identity only after authentication. No scope means no tenant rows; unscoped/cross-tenant inserts fail. Do not call the database facade recursively inside its transaction callback; use the provided transaction handle.

- `ao_runtime` accesses the current tenant and cannot read account password hashes or session tokens.
- `ao_identity` resolves global account/session/invitation credentials and memberships, and writes tenant-bound signup/acceptance records. It cannot read message content.
- `ao_dispatcher` can enumerate only workspace IDs.
- `ao_worker` handles runs and actions inside one explicit tenant scope.

These are NOLOGIN roles without SUPERUSER/BYPASSRLS. The API currently selects all four inside one trusted process. This boundary protects against accidental missing predicates and pooled context leakage; it does not protect against a compromised application deliberately selecting another tenant or the identity role. Further process/credential separation and audit hardening remain release work.

Development applies migrations automatically, using the development database owner. Production startup never migrates. Run the migration job first with `MIGRATION_DATABASE_URL`, a dedicated owner/DDL credential with permission to provision the application roles:

```sh
npm run db:migrate
```

Provision the production login separately through your database administrator. For example, in psql connected to the migrated database:

```sql
CREATE ROLE orchestration_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
GRANT ao_runtime, ao_identity, ao_dispatcher, ao_worker TO orchestration_app;
\password orchestration_app
```

Use your database's approved password/secret provisioning and TLS settings. Set the API's `DATABASE_URL` to that login and `NODE_ENV=production`; provide an HTTPS `WEB_ORIGIN`. Do not deploy `MIGRATION_DATABASE_URL` or an owner credential to the API environment. The startup check rejects superuser/BYPASSRLS or INHERIT logins, membership in any public table-owner role, missing application-role grants, or application roles that can log in or bypass RLS. The runtime does not need ownership or schema creation privileges. The same migration and request paths are tested against embedded PostgreSQL and a standalone PostgreSQL 17 connection pool.

## External agent protocol

Create an agent in the interface and securely copy its credential. Authenticate requests with `Authorization: Bearer <credential>`. Never place it in a URL, source file, screenshot, or public log.

1. Read `/v1/bootstrap` to discover the agent's identity and accessible channels.
2. Poll `/v1/agent/inbox` for pending explicit mentions.
3. Read permitted messages from `/v1/conversations/:id/messages`.
4. Submit a reply to `/v1/conversations/:id/messages` with `body`, a stable UUID `clientId`, and optional root `threadId`.
5. Claim a fenced lease, heartbeat it while working, and report its completion; see [the current receiving protocol](agent-execution.md#credentials-and-external-receiving).

A reply can use a deterministic client ID derived from the inbox item to survive transport retries. Receipt acceptance is not task completion. The durable lease/completion protocol now replaces receipt-only acceptance; see [agent execution](agent-execution.md). Private channels require explicit membership. Agent-authored messages do not automatically wake other agents.

External-agent execution remains customer-operated. The platform also supports managed agents through the separately configured eve service described below.

## Hosted execution and approvals

The managed service is a separate eve 0.83.0 application under `apps/managed-agents`. Its optional shell/file/web tools are disabled. A runtime inspection and no-inference smoke test verified an empty tool catalog, authenticated session creation, cleanup, and rejection of unauthenticated session requests.

Configure the root `.env` from `.env.example`:

- `EVE_RUNTIME_URL`: trusted operator-controlled runtime URL; loopback HTTP is allowed for local development, otherwise use HTTPS.
- `EVE_SERVICE_TOKEN`: a random secret of at least 32 characters, shared only between the API and runtime. For example, generate one locally with `openssl rand -hex 32`; keep it out of source control and logs.
- `AGENT_MODEL`: approved Gateway model identifier. The example uses `openai/gpt-6-luna`, verified against the catalog during implementation. Set this for both build and start.
- `AI_GATEWAY_API_KEY`: server-only model credential, or a supported deployment OIDC credential. No model credential is included in this repository.

```sh
npm run runtime:build
npm run runtime:start
# In another terminal, restart the API/web application to load the same environment:
npm run dev
```

The local eve service persists its workflow data under its `.eve` directory. Keep it on durable storage. The local workflow world is single-process; multiple replicas require a compatible shared Workflow World. Production environment selection and regional data processing must be qualified separately.

Create an agent with Execution set to Hosted, then use **Agent runs** to choose a source channel and submit a request. Explicit channel mentions also enqueue managed runs. The agent must have channel access, including explicit private membership. No inference occurs when runtime configuration is absent; the run API returns a structured 503.

A run snapshots instructions and receives at most 20 recent source-channel messages, each truncated to 2,000 characters. It has its own eve session, a renewable fenced lease and versioned duration/admission limits. Versioned run limits and atomic workspace spending reservations now apply; see [current execution controls](agent-execution.md#hosted-limits-spending-and-fair-scheduling).

The managed model returns a validated reply and at most four proposed actions. It does not receive database credentials, customer provider tokens, shell tools, web access, or a generic mutation executor. Reply publication, proposals, and run status commit together after current access is rechecked.

The first typed tools are:

- `create_task`: creates a proposed task assigned to the agent and scoped to the source conversation.
- `save_knowledge`: creates a knowledge page and its initial version within the source conversation.
- `delegate_agent`: creates a narrowed child run with explicit ownership, verification, contract, deadline, budget and stop conditions.

Every mutation waits for a human owner/administrator to approve the exact tool, schema/policy version, parameters, and source conversation. Approvals expire after 24 hours. Before execution, the gateway verifies the digest, recorded decision, current approver role/access, requester access, agent status/access, run state, and expiry. It then applies the local operation, action result, and audit/outbox events in one transaction. Retries and concurrent execution attempts consult the same invocation record and do not create duplicate resources. Approvals do not lend the approver's permissions to the original agent.

The registry additionally supports scoped reads, owned provider actions, isolated scratch execution and interactive forms. External actions use sealed capabilities, an append-only action ledger and receipt-only reconciliation; see [tools and knowledge protocols](tools-and-knowledge.md).

Cancellation fences future publication and actions immediately in the database and requests cooperative runtime cancellation. Pausing an agent cancels its open managed runs and unexecuted proposals. Approval waits live in PostgreSQL; they do not keep a model turn or HTTP request open.

If a worker loses its lease or observes an uncertain model outcome, the run becomes `outcome_unknown`; it is not automatically sent to the model again. **Check hosted result** reads the saved session's bounded event history and can publish a settled structured result through the same authorization and transaction path. It never sends a new prompt. If no result is settled, the run remains uncertain. A session-creation timeout before a session ID is saved can leave an empty orphan session; it cannot perform tool actions and expires under the runtime policy.

Delivered HTTP endpoints include `/v1/runs`, `/v1/runs/:id/cancel`, `/v1/runs/:id/reconcile`, `/v1/approvals`, `/v1/approvals/:id/decisions`, and `/v1/execution/capabilities`. Public responses omit service credentials and runtime session IDs. Browser views show run history, failures, exact proposed content, decisions, and applied-action status.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

API integration tests default to embedded PostgreSQL, exercise HTTP handlers through Fastify injection, and verify stored records. Playwright starts the web server automatically, reuses an existing development server locally, and starts a fresh production server when `CI=true`. Browser fixtures own disposable API/database state; they do not require the persistent development API:

```sh
npx playwright install chromium
npm run test:e2e

# Match CI: build first and leave port 3000 free.
npm run build
CI=true npm run test:e2e
```

The workspace browser test creates an isolated database and API, then verifies registration/verification, message persistence across reload, replies, task creation/transitions, knowledge publication, and agent identity creation. All browser API state is disposable; the browser still loads the actual Next.js application.

A hosted-execution browser test runs against an isolated in-memory database and a deterministic runtime fixture. It verifies the complete UI/API path from hosted-agent creation to run output, a pending proposal, human approval, and exactly one persisted task. This is not a live-model inference test. Backend integration tests cover replay, digest changes, expiry, cancellation, private audiences, revocation, reconciliation, and concurrent duplicate execution.

Direct/group browser tests verify two-user private messaging, attachment-only upload/download with exact bytes, live group renaming/removal/rejoining, and failed-upload recovery. File tests cover RLS/composite references, checksums, multipart limits, quarantine, safe previews, quota accounting, access revocation during scanning, and cleanup retries. Transport contract tests exercise the real AWS SDK against an isolated HTTP S3 fixture and ClamAV INSTREAM against an isolated TCP fixture; a live cloud bucket and live antivirus deployment have not been provisioned or qualified.

Content tests verify tied-rank/timestamp search pagination, cursor binding and tampering, current ACLs after group removal, both history directions across tombstones/new arrivals, independent thread windows, concurrent edits, retry identity, Unicode size limits, revision immutability and deferred snapshot consistency on PostgreSQL. Browser flows cover old-message/thread navigation, precise search jumps, filter pagination, knowledge conflict review, revision comparison/restore, lost-save response recovery and immediate clearing of private drafts after revocation.

Task integration tests verify nested and mixed graph cycles, reverse-edge concurrency, parent completion racing child creation, due-date filters and cursor identity, ownership, comment creation retries/versions/tombstones, assignment/comment notifications, forced RLS and immutable state evidence. Browser tests cover end-to-end dependency resolution and parent completion, date editing, older/live comments, notification navigation, edit conflict review, private draft eviction and paginated task filters.

A team browser test verifies invitation creation, new-account acceptance, role changes, suspension, restoration, and continued rejection of revoked sessions.

Notification/activity browser tests verify mention selection, private delivery, old-message navigation, persistent preferences, read/unread controls, timeline/thread typing and away/invisible presence. PostgreSQL tests cover multi-session aggregation, session-revocation cascades, stale heartbeat/typing revisions, private audience revocation, admission limits and concurrent messaging/presence writes. The database adapter consumes idle-pool disconnect events and reports only sanitized error codes; a real disconnect/reconnect test verifies this path.

A two-person live messaging test follows send → remote delivery → read receipt → edit → reaction add/remove → thread reply → independent thread receipt → unread badge → reconnect → stale delete confirmation → deletion with preserved replies. An additional browser test verifies retrying an uncertain send without duplication and switching channels before a delayed send response returns. Every browser fixture uses an unbuffered event-stream bridge to its isolated API. API tests cover version conflicts, creation replay after mutation, private-channel permissions, monotonic reads, forced RLS, live session revocation, subscription limits, audience-bound cursor encryption and cross-instance publication. PostgreSQL testing additionally holds a low-ID outbox transaction open while a higher ID commits, then verifies the late event is still delivered after resuming.

An account browser test follows signup → queued verification email → explicit confirmation → workspace access → recovery request → password reset → revoked old session → new-password sign-in → rejection of link replay. Tests use an explicitly test-only Gmail SMTP transport and mailbox; they do not send external messages or claim live provider delivery.

To test actual SMTP capture with a running local Mailpit inbox:

```sh
npm run email:dev
npm run test:email:local
# With the web dev server running:
MAILPIT_E2E=1 npm run test:e2e -- tests/e2e/account.spec.ts
```

The local SMTP integration checks signup, required verification, captured invitation links, password recovery, session revocation, proof replay rejection, payload erasure and the production guard. The browser option uses the real Mailpit provider/SMTP connection and follows captured links through the UI. Both use disposable databases and unique recipients, and delete only the capture messages they read. These checks validate local capture, not external deliverability.

`npm run test:runtime` checks the separately running eve service without sending a model prompt. A real hosted model turn still requires operator credentials and has not been verified with paid inference in this environment.

Browser selection is configurable with PLAYWRIGHT_EXECUTABLE_PATH. When unset, Playwright uses its installed Chromium. Do not commit a machine-specific executable path. The API suite defaults to embedded PostgreSQL. To run it against a disposable standalone server, set `TEST_DATABASE_URL` to an administrator connection with CREATEDB/CREATEROLE, and run:

```sh
npm run test -w @ao/api -- --no-file-parallelism
```

Each suite creates and drops a random isolated database. Serial files avoid racing cluster-wide role creation during migrations. The PostgreSQL-only test also provisions and drops a non-owner NOINHERIT login, checks startup rejection of an owner connection, runs concurrent tenant queries through the pool, verifies role/context reset after commit and rollback, and exercises authenticated requests/signup through the restricted login. Other integration tests cover invitation/account matching, concurrent claims, authority changes, stale versions, last-owner protection, suspension, hosted work fencing, approval revocation, and RLS coverage of every tenant table. PostgreSQL 17 validation passed. Cross-instance live event delivery is tested locally; fleet-scale behavior, media, enterprise federation, external provider actions and regional failover remain unverified.

### Revocation regression and continuous integration

Private-group access loss is handled before ordinary live invalidations. A validated revocation event immediately clears affected conversation/history/thread/detail state and permission-sensitive views, invalidates pending bootstrap responses and refreshes current authority. It is not discarded when ready/focus events or a bounded invalidation queue request a full refresh. Full refreshes reconcile bootstrap membership before fetching conversation content, so a forbidden former conversation cannot block the snapshot that removes it. Fresh snapshots also clear missing conversations when an event was missed. Bootstrap requests use cancellation and generation checks; superseded responses cannot restore access, including after sign-out.

Three deterministic browser regressions cover coalesced full-refresh/revocation events, recovery with a missed event, and a delayed obsolete bootstrap response. The original real-SSE group rename/removal/rejoin flow remains enabled. No retries or longer assertion deadlines hide these regressions.

The `Quality` workflow in `.github/workflows/ci.yml` runs on pushes and pull requests with read-only repository permissions, timeouts and cancellation of superseded runs:

- **Build and embedded database tests:** dependency installation, formatting (including workflow files), typecheck, serial embedded API tests and production build.
- **PostgreSQL 17 integration tests:** a health-checked disposable service, serial suites with separate temporary databases, and the real pooling/RLS/concurrency tests. Its credentials are test-only and do not use deployment secrets.
- **Chromium end-to-end tests:** browser/OS dependencies, production build, Playwright-managed production startup and isolated API fixtures. Focused tests are prohibited in CI and automatic retries are disabled. Reports, portable per-test screenshots and failure traces are uploaded for seven days, including failed runs. Only generated test/report directories are included.

Local equivalents use `npm run test -w @ao/api -- --no-file-parallelism`, the same command with a disposable `TEST_DATABASE_URL`, and `npm run build` followed by `CI=true npm run test:e2e`. The production browser command needs port 3000 free; Playwright starts and stops its own web process. On developer runs, it can reuse the existing server. Traces and reports contain synthetic fixture accounts; live provider credentials are unnecessary. Unload-time best-effort presence beacons can outlive a browser interception context and produce connection-refused proxy messages when no persistent API runs; the fixture assertions and data remain isolated.

Migration 033 repairs early installations that recorded migration 005 before its workspace row-lock privileges were included. It grants the same UPDATE privileges already present on fresh installations to the three application roles that use workspace row locks; RLS policies and tenant filters remain unchanged. An upgrade regression removes those grants on a disposable database, confirms the scheduler-style lock fails, reapplies migrations, and verifies role access, record preservation and cross-tenant rejection. Before repairing the existing development database, the single API owner was stopped and a local backup was saved under `.data/backups/revocation-ci-20261024`; its 9 workspaces, 16 memberships and 7 tasks were preserved.

The configuration follows the [GitHub PostgreSQL service pattern](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) and [Playwright CI/server guidance](https://playwright.dev/docs/ci). The workflow is configured in source and its commands have been validated locally; a remote GitHub Actions run requires the repository to be hosted and pushed.

## Remaining full-product work

### Planning baseline — October 24, 2026

This is the remaining backlog against the complete scope in [product specification](product-specification.md) and [architecture](../architecture.md), reconciled with the current source tree. Existing authentication, invitations, tenant RLS, messaging, private groups/files, in-app notifications, presence/typing, lexical message/wiki search, knowledge revisions, task graph/comments, recurring tasks/reminders/calendar, task files/bulk/Kanban, and projects/milestones/labels are delivered foundations. Hosted runs, coordination, versioned tool policies, owned provider dispatch and governed collaborative knowledge are implemented. Product-specific connector integrations and live deployment qualification remain explicit work.

The list distinguishes missing capabilities from configuration and production qualification. A planned architecture component is not evidence of working implementation. No completion percentage or calendar estimate is asserted: those require team size, provider choices and acceptance evidence.

**Current verification:** 293 PostgreSQL API tests pass. The embedded suite passes 289 tests with four PostgreSQL-only checks skipped. All 53 production-browser flows pass, followed by eight knowledge/browser checks after the final lineage policies. Production web build, managed-runtime compilation, typecheck, formatting and production dependency audit pass. CI includes runtime compilation, PostgreSQL and browser jobs; remote CI execution and live provider qualification are not claimed by these local results.

### Recommended delivery order

1. **Correctness and continuous verification — implemented in the current slice:** client revocation is fixed, browser regressions pass, and real PostgreSQL plus browser CI jobs are configured. Maintain these gates as the product expands.
2. **Finish the core workspace experience:** account/workspace administration, remaining messaging/file features, task collaboration/templates, knowledge editing and notification controls.
3. **Qualify agent execution and extend tools:** deployed runtime recovery/billing/receiver qualification, additional capability adapters and generalized external tool policies. Core versions, credentials, durable receiving, coordination and atomic admission are implemented.
4. **Establish context integrity and connection security:** provenance, permission-aware retrieval, memory lifecycle, credential isolation and provider reconciliation. These are gates before broad autonomous external mutations.
5. **Deliver connected work:** connector batches, developer interfaces, automations, migration and shared channels with provider-specific acceptance suites.
6. **Complete communication across clients:** calls/transcripts, desktop/mobile, offline behavior and push delivery.
7. **Complete commercial and enterprise surfaces:** organization policy, federation/provisioning, billing, governance and customer administration.
8. **Qualify general availability:** production deployment, recovery/failover, security assessment, load, accessibility, support and complete cross-system workflows. Infrastructure, security, observability and cost work start in parallel with step 1.

### R01. Immediate correctness and activation

- [x] Resolve the live group-access revocation regression, including stale bootstrap/content responses, event ordering and client cache clearing; add deterministic regression coverage.
- [x] Obtain a clean full browser run after the fix and preserve API authorization/tenant regressions.
- [x] Extend the existing CI workflow with disposable real PostgreSQL and browser execution; retain useful failure artifacts. Basic formatting/build/typecheck/API CI already exists.
- [ ] Activate and qualify live model inference and the hosted runtime using operator-owned configuration. Test cancellation, checkpoint recovery and persistent storage with the chosen deployment.
- [ ] Activate live transactional email when desired; provider code already exists. Configure an authorized sender/account and verify delivery without bypassing verification.
- [ ] Add delivery/bounce/complaint webhooks, suppression handling, recovery/security notices and deliverability monitoring.

### R02. Organization, account and member administration

- [x] Organization records above workspaces, verified domains, security policy and deployment-bound workspace regional assignment.
- [x] Account/profile management, signed-in credential changes and verified email changes; session/device listing and selective revocation.
- [x] OIDC/SAML federated sign-in, TOTP MFA/enrollment/recovery, enterprise SSO requirements and SCIM user/group provisioning/deprovisioning. Qualify real customer IdPs before activation.
- [x] Guest and service identities, explicit conversation audiences, capability overrides and scoped expiring service credentials.
- [x] Organization/workspace ownership transfer, current-resource offboarding with task/project reassignment, execution fencing, credential/share revocation and explicit restoration.
- [ ] Billing ownership, custom role catalogs, broader resource delegation and regional migration/failover qualification.
- [ ] Extend offboarding to future business-provider connections and automation ownership when those modules exist; implement retention/erasure policies.
- [ ] Agent roster details for owner, verified runtime capabilities, availability and current work.

### R03. Messaging and personal organization

- [x] Rich-text composition/rendering and structured mention tokens; replace name-based agent activation with explicit identity references. Human mention IDs already exist.
- [x] Pinned and saved messages, stable user-facing permalinks and explicit thread-follow/unfollow controls.
- [x] Durable drafts, scheduled messages, protected local caches and an offline operation outbox with permission revalidation before replay.
- [x] Custom sidebar sections/order, channel discovery/joining, channel management and archive/restore.
- [x] Configurable retained-history versus join-time access, membership intervals/history grants and explicit consent for expanding private group history.
- [ ] Unified attention for failed runs, decisions and other outstanding work beyond the existing notification categories.
- [x] Measured virtualization for long main/thread timelines and cursor pagination in agent/member/invitation/knowledge/audit/run/approval views.
- [ ] Large-workspace load, fleet-scale operation, and extended accessibility qualification.

### R04. Tasks, projects and workflow authoring

- [x] Task watchers/collaborators, explicit acceptance criteria, attributed human verification, and typed immutable artifacts.
- [x] Source-discussion/decision links and task-to-run associations with multiple attempts and preserved ownership.
- [x] Published task/workflow revisions, event-driven steps, approval/wait states, execution history, fenced replay, and failure/deadline escalation.
- [x] Project state/effort/workload/completion reporting, planned task dates and timelines, and audience-bound portfolio rollups.
- [x] Versioned business calendars, holiday-aware recurring work, Google Calendar synchronization, external-edit conflicts, and revocable iCalendar subscriptions.
- [ ] Additional provider qualification, independent project membership/chat, broader branching/code/webhook automation and generalized external side-effect reconciliation, portfolio-level dependencies and fleet-scale reporting qualification.

See [work-management implementation and operating boundaries](work-management.md).

### R05. Agent configuration and durable external receiving

- [x] Immutable agent revisions with instruction/model/tool/skill, activation, conversation and limit settings; version-aware management UI and captured run revisions.
- [x] Ownership transfer, pause/activation, archival/restoration, connection revocation and offboarding integration.
- [x] Scoped credentials with expiry, creation, rotation, revocation, usage metadata and paginated credential history.
- [x] Runtime capability/configuration visibility, observed contact, backlog and dead-letter review.
- [x] Inbox leases, fencing, heartbeats, backoff, expiry, completion tracking, managed run linkage and explicit redelivery.
- [x] Encrypted signed webhook configuration, durable transport attempts and recipient-private realtime wake-ups.
- [ ] Live customer receiver onboarding/transport qualification, provider-specific capability attestation, and operational fleet load qualification.

### R06. Hosted execution and multi-agent coordination

- [x] Append-only checkpoints, safe observation recovery, explicit reconciled restart and artifact/trace export; capability-gated long observations.
- [x] Bounded tenant/requester-fair dispatch, replica-safe workspace/agent/requester concurrency, duration/tool/token/model-call limits and approved model policies.
- [x] Atomic spending reservations, operator pricing bounds, runtime settlement, retained unknown reservations and audited provider-receipt reconciliation.
- [x] Task-linked progress, public action/result traces and safe export projections excluding raw reasoning and service credentials.
- [x] Approval-gated agent delegation with narrowed authority, owners, output contracts, deadlines, budgets and stop conditions.
- [x] Root/parent graph, depth/child/budget limits, ancestor loop prevention, exact-payload deduplication, escalation and independent verification; workflows wait for accepted descendants.
- [ ] Qualify live inference/billing, persistent checkpoint storage, process restart, cancellation and replica behavior in the chosen deployment before setting the durability qualification flag. Additional runtime adapters and automatic model/provider fallback remain separate work.

See [agent execution protocols and operating boundaries](agent-execution.md).

### R07. Generalized tools, approvals and secure execution

- [x] Versioned eight-tool read/write registry with source/resource selectors, grant checks, cost categories, deadlines and bounded/redacted results.
- [x] Versioned workspace effect policies for publication, deployment, access, payments, destruction, export and execution, with owner/admin/independent review and exact destination/effect previews.
- [x] External intent/result ledger, stable provider idempotency, receipt-only uncertain-outcome reconciliation and audited owner attestations.
- [x] Encrypted short-lived single-use execution capabilities and current requester/agent/connection-owner authorization.
- [x] Disposable network-denied microVM execution for code, shell and in-memory SQLite with output, time, CPU and memory boundaries.
- [x] Shared public-endpoint SSRF defenses, DNS/address pinning and redirect denial for registered adapters and webhooks.
- [x] Schema-driven interactive forms in opaque-origin sandboxed iframes, with normal server authorization and audited submissions.
- [ ] Organization-level policy inheritance, provider-specific/MCP adapters, private-network connectors, customer database identities and arbitrary separately hosted mini-app bundles.
- [ ] Live provider/sandbox regional, billing, idempotency and failure qualification with operator-managed accounts.

### R08. Knowledge authoring and canonical context

- [x] Safe Markdown rich-text authoring, Yjs simultaneous synchronization, generation fencing, immutable publication versions and attributed page discussion.
- [x] Human ownership, assigned reviewers, all-reviewer acceptance and review epochs that bind provenance and governance as well as page text.
- [x] Dictionary, decision, procedure, project-context, summary and journal categories with rich-text content.
- [x] Exact page/message provenance, freshness, supersession, contradiction review and transitive correction/deletion invalidation.
- [x] Database-enforced current/historical source lineage, including private join-time boundaries and access checks for new owners/reviewers and automated reads.
- [x] Scheduled cited extractive proposals with current owner/source authority, base-version checks, explicit acceptance and authoritative correction preservation.
- [x] Governed provenance exports, archive/restore, deletion reasons, retention, legal holds and narrowly authorized physical erasure.
- [ ] File/connector provenance, model-backed synthesis adapters and propagation into future external/vector indexes.
- [ ] High-fanout collaborative-editing deployment/load qualification and structured WYSIWYG block extensions beyond Markdown.

See [tools and knowledge protocols, setup and boundaries](tools-and-knowledge.md).

### R09. Retrieval, search and inspectable memory

- [x] Cross-content message/page/task search, scanned file extraction with optional OCR, connected imports and consented retained transcripts; Unicode segmentation and configurable multilingual embeddings.
- [x] Durable chunk/index/embedding jobs, bounded lexical/vector ranking, cited extractive answers and freshness/conflict/missing-evidence indicators.
- [x] Source-aware forced RLS before hydration; current authority/version checks before model input and publication; member/credential/account/policy-bound reference contexts and realtime revocation invalidation.
- [x] Inspectable agent memory with private/conversation/workspace boundaries, transitive provenance, expiry, attributed corrections, physical deletion and governed export.
- [x] Audience-preserving forwarding, explicit all-source-owner declassification with immutable releases/revocation, and reused hosted-context/checkpoint fencing.
- [x] Rebuild/freshness/queue health endpoints, repeatable multilingual lexical relevance and latency evaluation, and portable PostgreSQL vector storage before selecting another service.
- [x] Exact-revision mixed-owner consent inbox, independent source-owner decisions, immutable publication and withdrawal invalidation; optional model-written answers with exact quoted support checks, source revalidation and atomic daily/concurrent allowances.
- [x] Concurrent synthetic relevance/latency evaluation and an explicitly gated, optional model-specific multilingual evaluation harness.
- [ ] Live model-specific multilingual quality and production corpus/load qualification. The 300-candidate recall cap is explicit and remains a measured implementation limit.

### R10. Connections and connector catalog

- [x] Personal/workspace owned connections, explicit expiring consumer/resource/read grants and signed bridge subscriptions. Separately qualified external writes continue through the existing approval/action system.
- [x] Google Drive, Linear, GitHub, GitLab, Jira, Microsoft 365, Notion and HubSpot OAuth consent; provider-specific PKCE/client authentication, scope checks, denial consumption, refresh leases, encrypted credentials and version-fenced reconnect/offboarding.
- [x] Operation manifests documenting scopes, resource formats, local limits, approval/idempotency/reconciliation boundaries, attribution, configuration and qualification limits.
- [x] Bounded engineering read adapters: GitHub/GitLab/Linear/Jira/Sentry issues, Honeycomb boards, Vercel deployment status and Datadog monitors.
- [x] Bounded knowledge/meeting read adapters: Notion paginated/nested block text, Google document text, Microsoft 365 item metadata, Granola notes/transcripts, Fathom and Fireflies transcripts.
- [x] Bounded business read adapters: HubSpot contacts, Attio records, Stripe customers, Ramp transactions, Shopify products and Zendesk ticket descriptions.
- [x] Bounded analytics/data adapters: PostHog insights, Hex project metadata, delegated-user/approved-column Supabase rows and operator-allowlisted named database read proxies.
- [x] Signed bridge ingress/outgoing status notifications, event deduplication and refetch reconciliation, rate-limit backoff, leased retries/dead letters, explicit subscriptions and verified-sender service-identity email-to-channel.
- [x] Native approved field updates for nine providers through the existing hosted action ledger, exact resource grants, reviewed previous values, current approval checks, provider-key/postcondition receipts and read-only uncertain-outcome reconciliation.
- [x] Native signed GitHub, GitLab, Linear and Stripe ingress with exact-byte deduplication, hook-generation fencing, expiry/rotation, scoped refresh and confirmed remote deletion.
- [ ] Automatic remote subscription provisioning, binary/Office document bodies, and additional operation/provider/region coverage beyond the explicit catalog manifests.
- [ ] Independent provider test-account validation for every operation. All live catalog qualification remains `unvalidated`; fixture coverage and owner-attested validation records do not establish complete provider coverage.

See [retrieval, memory and connection protocols and qualification boundaries](retrieval-and-connections.md).

### R11. Automations and proactivity

- [x] Versioned owner-bound definitions, immutable revisions, pinned agent/template authority, source/destination grants, daily spending and failure policies.
- [x] Scheduled agent checks, recurring workflows and event-driven rules through the existing execution/workflow engines.
- [x] IANA timezone/DST policies, missed-run handling, overlap/queue/concurrency limits, occurrence deduplication and child-state reconciliation.
- [x] Paginated run/revision history, upcoming previews, pause/resume/archive, reasoned replay, persistent escalation, and accepted ownership transfer. Offboarding fences execution and pauses admission; it never silently transfers authority.
- [x] Participation/quiet-hour/cooldown/publication controls, reply fingerprints and structured meaningful-change hints, origin loop suppression, and actual/reserved cost reports.
- [ ] Independently qualify usefulness/semantic-change decisions and long-running model/provider behavior in live accounts. Meaningful-change suppression currently combines deterministic reply fingerprints with an explicit model hint; it does not claim a separately trained semantic novelty detector.

See `docs/automations.md` for exact scheduling, replay and authority semantics.

### R12. Public developer platform

- [x] Versioned public REST operation registry, OpenAPI 3.1.1, generated TypeScript/Python client contracts, additive compatibility policy and CI drift checks.
- [x] First-party stateless MCP server, official SDK protocol compatibility, OAuth discovery/resource audience checks and scope-filtered tool execution.
- [x] Owner-controlled custom remote MCP connections, bounded discovery, reviewed manifests/effects, current consumer grants, health/refresh/rotation, and approved dispatch through the existing action ledger.
- [x] Public event batches/SSE, signed webhook delivery/retry/dead-letter history, scoped/expiring/rotatable API keys, explicit OAuth workspace/acting-member consent, rotating refresh families and reuse revocation. Existing service accounts remain separate; public OAuth does not impersonate another identity.
- [x] Local SDK source packages, REST/MCP/hosted-run/webhook examples, connector authoring documentation, protocol/contract/security suites and browser management flows.
- [ ] Independently qualify third-party MCP/provider accounts and OAuth client deployments. Generic remote MCP writes intentionally remain uncertain after an interrupted response; there is no automatic write reconciliation without a provider-specific contract. Remote-result ingestion into knowledge/model context remains an explicit governed integration, not automatic forwarding.

See `docs/developer/README.md`, `docs/developer/openapi.json` and `docs/developer/connectors.md` for supported operations, setup and exclusions. The public registry currently covers the documented core operations, not every browser administration route. SDK packages are local source packages and have not been published.

### R13. Migration and interoperability

- [x] Paused import definitions, retry-safe staging, read-only preflight/dry runs, reviewed channel audiences, explicit identity reconciliation and unsupported-content/file omission reports.
- [x] Restartable Slack history with original external authors/timestamps, stable origins/revisions, thread roots, source reactions and scanned-file mappings; no inferred accounts or permission grants.
- [x] Durable inbound buffering, atomic checkpoints, duplicate/revision checks, per-channel SHA-256 origin checksums and bounded completeness/progress reports.
- [x] Optional inbound/bidirectional signed relay protocol, encrypted owner-controlled secrets, source/local/manual conflict ownership, echo suppression, fenced claims, disconnect, uncertain-outcome inspection and evidence-backed reconciliation.
- [x] Independently tested Slack, Teams and Discord normalization and fixed-origin native read transports. Buzz is excluded from this implementation at the user's request.
- [x] Paged streaming readable workspace/shared-channel tar exports with stable IDs, authorship/timestamps, source metadata, retained binaries, current-access checks, knowledge export governance and omission manifests.
- [ ] Live provider application/account qualification, private-history authorization/completeness, native outbound effects and continuously operated collector/reconnect acceptance. Deploying a collector remains an explicit operator action; credentials and local tests do not establish live provider coverage.

See [migration and interoperability](interoperability.md) for concrete payloads, supported native formats, review boundaries, relay examples and deployment requirements.

### R14. Shared channels across organizations

- [x] Private owning workspace, hashed/expiring external organization invitations, exact bilateral policy consent and explicit individual participation grants.
- [x] Source-linked external identity attribution and narrow channel operations without a host organization membership/session or access to other workspace channels.
- [x] Identical history/retention/export/recording/host-agent terms, source/host authentication and region compatibility, policy revision fencing and durable accepted restrictions after revocation. Recording is explicitly disabled pending the calls platform.
- [x] Participant management, bilateral revocation, recipient-scoped shared activity, retention tombstones/file cleanup, context invalidation and direct PostgreSQL cross-organization/offboarding/file/export regression coverage.

Shared channels use source workspace sessions with channel-scoped shadow guests. Accepted terms cannot be silently relaxed by revoking a grant; a channel with different terms requires a fresh agreement in a new channel. Operational backup erasure remains part of R19 rather than an implied immediate effect of channel retention.

### R15. Calls, transcripts and voice agents

- [ ] Conversation-authorized audio/video rooms, screen sharing, devices, participant controls and short-lived media tokens.
- [ ] Server-authoritative recording/consent policies and clear indicators before joining and during mode changes.
- [ ] No-recording, transient-caption and retained-recording modes with separate lifecycle controls.
- [ ] Timestamped/speaker-attributed/correctable transcripts, chapters, cited summaries and reviewable action-item proposals.
- [ ] Private media storage/search, separate media/transcript retention, revocation and provider-gap handling.
- [ ] Transcript access for agents; separately consented live voice-agent participation, interruption/turn-taking, narrow context and cost controls.

### R16. Notifications and attention completion

- [ ] Web/OS push, native desktop and mobile delivery, device registration/revocation and delivery history/receipts.
- [ ] Notification email/digests, quiet hours, batching, priority/escalation and per-device/channel/agent routing.
- [ ] Explicit conversation/thread following and more granular preferences beyond current category/mute controls.
- [ ] Separate agent wake-up and human interruption policy; deduplicate unchanged failures and explain proactive interruptions.
- [ ] Larger-workspace presence pagination/fan-out and notification latency/backlog qualification.

### R17. Files and supported clients

- [x] Immutable file versions, resumable chunked uploads, range downloads, expiring recipient links, DLP policies and reinspection, with current source-access checks and local/PostgreSQL tests.
- [x] Desktop sandbox/origin restrictions, local startup verification, and signature-bound update implementation; iOS/Android client sources, configuration checks, and compiled platform JavaScript bundles.
- [x] Account-persisted getting-started checklist with six language catalogs; scoped browser accessibility checks for new file/billing/onboarding controls.
- [ ] Bucket migration, richer DLP engines, legal holds and retention administration.
- [ ] Signed/notarized desktop builds and update acceptance; deep links, OS capture picker and platform notification qualification.
- [ ] iOS/Android native builds/signing/store distribution, native push/media/file acceptance, durable OS-protected caches and background/offline synchronization.
- [ ] Complete client parity, full product localization, comprehensive accessibility/device qualification, and guided team/agent/provider-health onboarding.

### R18. Billing, usage and commercial controls

- [x] Versioned plan definitions, once-only trials, unique human-seat admission, capability gates and quantity allowances.
- [x] Stripe SDK checkout/portal/subscriptions, plan-change proration previews, invoices and cancellation; local SDK transport/signature tests. No provider provisioning or live payment performed.
- [x] Append-only quantity/cost ledger, atomic organization reservations, warnings, hard budgets, forecasts, and idempotent operator receipt adjustments.
- [x] Signed/deduplicated event queue, canonical provider retrieval, account leases/fencing, periodic reconciliation, uncertain-command retries and complete streamed billing exports.
- [ ] Independent Stripe test-account/live acceptance, signed distribution, effective-dated seat reports, provider-actual runtime/media/egress/embedding/delivery pricing, invoice tax/local-currency qualification, refunds/disputes and operator replay/failure administration.

See [file/client/commercial operations and exact qualification limits](files-clients-billing.md). Native source projects and fixture payment tests are not production distribution/provider qualification.

### R19. Enterprise governance and data lifecycle

Implementation details and explicit limits: [enterprise governance](enterprise-governance.md).

- [x] Versioned owner-approved organization policies; database admissions for models/agents/tools/connections/sharing/recording; current tool/connector/export rechecks.
- [x] Searchable/paged audit metadata, private resource redaction, snapshot-bounded NDJSON exports, legacy backfill, immutable application journals, hash-chain verification and operator-signed head anchors.
- [x] Time-limited, purpose/ticket-recorded, MFA-restricted aggregate support diagnostics with owner approval and immediate revocation.
- [x] Workspace/conversation holds and destructive source/child guards; fenced, restartable per-source erasure and scheduled retention; physical storage and signed component/backup evidence states.
- [x] Access-checked streaming organization archives with current workspace administrator membership and explicit omissions.
- [x] Versioned authenticated credential envelopes, retained decrypt-only keys, bounded dry-run/apply rewrapping and separate API/worker entry points.
- [x] Unpublished privacy/data-flow, DPA/subprocessor outlines, recovery/incident guidance and security evidence register.
- [x] Isolated OpenAI BYOK broker with public-key sealing, immutable run/key bindings, short-lived transport capabilities, current-access checks, no platform fallback and uncertain-outcome protection.
- [ ] Additional BYOK provider coverage, exhaustive outbound/forwarding policy enforcement, independently qualified regional flows and dedicated deployments.
- [ ] Independently operated append-only audit sink, anchor comparison, audit retention and event-completeness assessment.
- [x] Organization-wide access freeze, legal-hold-aware erasure, durable storage inventory/batches, S3 versions/multipart cleanup, transactional source/derived/history removal and independent receipt gates. Global accounts and documented audit/financial records remain distinct.
- [ ] Account-level erasure; live provider/media deletion acceptance, remote backup inventory/expiry and restore tombstone replay. See [the organization erasure/BYOK protocol](organization-erasure-byok.md).
- [ ] Stored expiring organization export grants, complete artifact coverage and provider acknowledgements.
- [ ] Managed vault/key custody, proven key retirement, trusted identity/realtime/credential-proxy isolation and least-privilege fleet qualification.
- [ ] Legal approval/publication of contracts/notices and independent security/compliance assessment. Drafts are not executed agreements or certification.

### R20. Production infrastructure, reliability and release qualification

Implementation details and commands: [production operations](production-operations.md).

- [x] Non-root API/web container builds; production compose blueprint with explicit secret files, private services, separate workers, ClamAV and Caddy HTTPS configuration.
- [x] Shared PostgreSQL-backed rate limits, route separation, explicit trusted proxies and fail-closed limiter behavior.
- [x] Private bounded request metrics, generated request correlation IDs, sanitized exception logging, aggregate queue/deletion visibility, reason-recorded eligible dead-delivery replay and initial alert rules.
- [x] Dependency/CodeQL security workflow and manual release-candidate source/container scanning, recovery/load checks; signed, expiring, build/artifact-bound evidence validation.
- [x] Encrypted custom-format PostgreSQL backup and signed manifests; authenticated empty-quarantine restores; automated PostgreSQL 17 record recovery and corruption-rejection drill; bounded synthetic load baseline.
- [x] Governance/status browser flows with axe checks; operator-only explicit incident publication and public `/status`; opt-in aggregate activity counters.
- [ ] Provision and qualify production domains/TLS, database/PITR, private object/media/scanning, runtime, vault, queues/collectors and regional data flows. No production deployment is created by the blueprint.
- [ ] Durable broker/fan-out/backpressure and all-queue event retention/receipts; multi-replica runtime, connection and downstream reconciliation qualification.
- [ ] Distributed tracing, latency histograms/SLO dashboards, queue/cost/permission alerts, installed paging and on-call exercises.
- [ ] Signed published images, protected migration/deployment jobs, mixed-version releases, canaries/staged rollout and proven automated rollback.
- [ ] Managed PITR/object/media recovery, deletion-journal replay, regional failover/fencing/failback and measured RPO/RTO.
- [ ] Realistic hot-tenant/soak/performance tests, deterministic safety/recovery/leakage matrices, live provider accounts, cross-client/manual accessibility and independent penetration testing.
- [ ] End-to-end customer pilot acceptance, verified outcome/intervention/cost analytics, staffing/support tiers, reviewed service commitments and launch approval.

### Decisions needed for scheduling, not for reducing scope

Choose final branding/customer segment, launch jurisdictions, production regions/residency, deployment providers, model/BYOK policy, pricing/allowances, connector priority, enterprise requirements, supported client matrix and whether voice agents/dedicated deployments/marketplace ship at initial general availability or later. An external marketplace is a product decision, not an implemented capability. Team size, budget and support staffing determine calendar estimates. The complete agreed product scope remains intact.

## Known implementation limits

- Email verification/recovery, verified email changes, TOTP MFA, OIDC/SAML federation and SCIM are implemented. Security/recovery notices and deliverability/bounce webhooks remain in scope. Live email and customer IdPs require operator configuration; see [identity operating limits](identity.md).
- RLS enforces workspace isolation and explicit guest/service content audiences. Other private-conversation ACLs and human resource ownership remain application policy. API and background workers have separate process entry points; trusted identity and credential roles still require stronger service/credential separation.
- Production uses shared PostgreSQL rate limits with explicit proxy trust; hot-tenant load and a separate limiter/broker remain qualification decisions.
- Live updates use resumable SSE backed by committed outbox publication. Broker fan-out, fleet-scale qualification, downstream consumer receipts, event retention and dead-letter handling remain to be built.
- Service principals have explicit capability/conversation scope and expiry/revocation. Legacy external-agent keys retain their separate agent lifecycle; expiry/rotation UI and durable receive leases for those keys remain to be built.
- Human-created tasks/wiki offer explicit workspace or conversation audiences. Managed output and tools inherit their source conversation; retrieval and memory now enforce explicit source audience intersections, including files and connected imports. Broader automatic synthesis and multi-owner declassification still require qualification.
- Agent mention matching currently uses a case-insensitive name occurrence. Unique mention identifiers and structured mention tokens are needed before automated coordination expands.
- Messaging supports Markdown, structured identity mentions, protected drafts and offline replay. Complete accessibility certification and cross-client parity remain in scope.
- Migration scripts support quoted strings, nested comments and dollar-quoted procedural bodies. Deploy migrations through the separate job before starting the production API.

These limitations are tracked release work, not claims of implemented production controls.

## Messaging and personal organization

Implemented behavior, protocol changes, authorization boundaries, offline storage, and scheduler operation are documented in [messaging implementation](messaging.md).

## Automation and developer platform verification — 2026-10-25

The automation and developer platform changes passed the full PostgreSQL suite (423 tests), the embedded database suite (419 passed, four PostgreSQL-only checks skipped), and all 62 browser tests. The Python SDK's three compatibility tests, TypeScript checks, generated OpenAPI drift check, production build, and managed-runtime compilation also passed. The final escalation permission-revocation change passed its 15 affected PostgreSQL tests. The production dependency audit reported no known vulnerabilities.

The local database was backed up and migrated to schema 65 with core record counts preserved. Disposable test services were stopped after verification. Live model execution, customer OAuth applications, provider accounts, delivery endpoints, and independently hosted MCP servers still require deployment-specific validation; no live qualification or SDK publication is implied by these local results. See the [automation guide](automations.md) and [developer guide](developer/README.md) for behavior, configuration, and operational limits.

## Migration and shared-channel verification — 2026-10-26

The full PostgreSQL suite passed 436 tests. The serial embedded suite passed 432 tests with four PostgreSQL-only checks skipped, and the serial browser suite passed all 64 tests. The final relay authentication/export/forwarding guards additionally passed all 13 affected interoperability/provider/file tests on both database adapters. TypeScript, formatting, generated OpenAPI drift, the three Python SDK tests and the production web build passed. No assertions or test deadlines were weakened.

The local embedded database was backed up under `.data/backups/interoperability-2026-10-25T18-39-49-664Z` and migrated from schema 65 to 67 with core record counts preserved. Disposable PostgreSQL and browser services were stopped, and project service ports were confirmed closed. Live provider application, private-resource, collector and outbound-effect qualification remains pending; the local results do not establish live Slack, Teams or Discord coverage. See [interoperability operations](interoperability.md).

## Calls and notification delivery

See [calls, consent, transcript editing, delivery configuration and remaining acceptance work](calls-and-delivery.md). Calls use self-hosted LiveKit/Egress. Automatic speech recognition and live voice-agent audio remain unimplemented; APNs/FCM and browser push require device/provider acceptance.
