# Messaging and personal organization

This release adds rich messaging, personal message collections, durable composition, scheduled delivery, offline replay, channel administration, and explicit history grants. Migration `035_messaging_organization.sql` preserves existing message IDs, plaintext messages, conversation access, and tenant boundaries.

## Composition and identity mentions

The composer supports Markdown formatting, lists, quotes, code blocks, links, tables, and a rendered preview. Existing messages retain their plain-text format. Rendering uses `react-markdown` and GFM with raw HTML and remote images disabled; link rendering accepts explicit HTTP(S) destinations. Uploaded files keep their existing scanned attachment flow.

Mention selection inserts an identity link, such as `[@Atlas](mention:<membership-id>)`. The API parses Markdown syntax rather than scanning display names: code samples and escaped links do not activate agents. Labels are presentation; the membership ID selects an active, authorized conversation participant, and reads project the current name. Agents are awakened by explicit identity mentions, or by a direct conversation addressed to that agent. Typing `@Atlas` as ordinary text no longer activates an agent. Existing explicit human-mention IDs and unambiguous plain-text human mentions remain compatible. Editing a mention updates the message's mention references; agent activation remains a creation-time action.

Messages carry a format and immutable creation-request fingerprint. Replaying a client ID cannot change its original conversation, thread, text, format, attachments, or explicit mentions. Queued browser requests additionally bind the expected author, membership version, and conversation membership interval. Leaving and later rejoining a private group cannot silently revive an earlier queued send.

## Personal collections and links

Message actions support save/unsave, pin/unpin, follow/unfollow, and copying a stable link. Saves and explicit follow preferences belong to one workspace member. Pins are shared with eligible conversation readers. Listing a collection rechecks the current message audience and history grant; deleted or inaccessible messages cannot be recovered from a saved snapshot.

A permalink uses `/?workspace=<workspace-id>&message=<message-id>`. An authenticated reader can switch to an already-authorized workspace and open the message's main timeline or thread context. A link grants no access. Explicit following can notify someone who has not participated in a thread; explicit unfollowing suppresses the automatic reply-follow behavior. Mention and mute preferences still apply.

The **Your messages** view exposes Saved, Following, Drafts, Scheduled, the device's offline outbox, and the current conversation's pins.

## Drafts, scheduling, and offline operation

Drafts are stored per workspace member, conversation, and optional thread. Server updates require a captured version; a conflicting device cannot overwrite a draft silently. The client keeps an encrypted local copy before remote synchronization. Conflicts offer an explicit choice of the saved draft or the current local text. Ready attachment references can be restored, and unavailable attachments require review before sending.

Scheduled messages have a durable client key, captured credential epoch and organization policy version, due time, optimistic version, and terminal delivery state. A member can reschedule or cancel an undelivered message. Admission is limited to ten seconds through one year ahead and at most 1,000 pending messages per member. Uploaded attachments remain reserved through their scheduled delivery window. Expiring identity or changing permissions, organization policy, source access, thread visibility, or channel archive state can block delivery. A blocked message requires explicit review and a new scheduling request; it is not released automatically when access returns.

`MessageDeliveryWorker` starts with the API process and checks due work every five seconds. It uses tenant-scoped transactions, stable workspace/conversation/run lock order, row fencing, and the same send service as interactive messages. Message creation, mentions, attachments, notification/outbox records, and the schedule's terminal state commit together. Replica retries use the original client ID. No database lock spans external network I/O. The process can restart without losing scheduled work.

The browser uses IndexedDB and AES-256-GCM with non-extractable per-identity CryptoKeys and record-bound authenticated data. Drafts, queued bodies, and the last verified workspace metadata are encrypted, rather than stored as plaintext in localStorage. This protects the stored representation; it does not provide an OS keychain or protection against an attacker already executing application JavaScript.

The production service worker caches only the public application shell and same-origin immutable Next.js assets. It never caches API responses, authentication callbacks, downloads, or message history. A last-verified workspace metadata snapshot can initialize the shell offline for up to 24 hours; published message history is fetched again when connected. Local drafts and queued sends survive reloads. The interface does not treat cached metadata as current server authority.

An offline or uncertain send is persisted before the network attempt. Reconnection verifies the active workspace and member, then submits the original client ID with expected-author and grant checks. The outbox stops on network failure, marks authorization/validation failures for review, and expires requests after seven days. It cannot send under a different signed-in account. A response lost after commit is recovered through idempotency instead of creating another message. Sign-out clears local messaging keys and records. Received access-revocation events purge the affected conversation's local composition records; the server rechecks access even if that event was missed.

## Channels, sidebar, and private history

**Discover channels** lists public channels plus private channels already shared with the viewer. It supports search, cursor pagination, joining/leaving public channels, and an archived-channel filter. Administrators can rename a channel, edit its description, set the policy for future joins, and archive or restore it. Archived channels retain readable history and reject new messages, edits, and hosted run admission; archive fences open execution. Pending scheduled messages are checked again at delivery.

Sidebar settings store versioned personal sections, section order, conversation order, and hidden conversations. These preferences do not grant access. Archived conversations are removed from the active sidebar and remain available through discovery. A full workspace member can browse retained public history without joining; a join-time public channel requires membership before history and composition are available.

Conversation history can be retained or start at joining. New private groups default to join-time history. Existing groups retain their previous policy and current members keep their existing grants. Changing the default policy governs future joins; it does not widen existing members' history. Each membership interval records its explicit sequence floor and departure. Rejoining creates a new interval and does not revive a previous history grant. Replies to an inaccessible old root remain inaccessible, including newly posted replies to that root.

Sharing retained private group history requires a proposal from a current group owner and approval from every active human participant. The request binds the target, exact participant audience, group version, and a 24-hour expiry. A rejection or an audience/version change prevents applying it. Acceptance, the new history grant, version advancement, execution cancellation, and audit/outbox changes commit together. Merely adding someone from the current point does not expose earlier context. Group details expose the request and voting controls.

An existing private group's membership must be expanded through group participant management, including machine principals. Bulk workspace access/invitation/service-account scope updates cannot bypass that process. The database insertion trigger rejects alternate audience-expansion paths once the group has history. A service principal can be given channel access first and then added by the group owner with the appropriate history choice.

Forced PostgreSQL policies enforce message sequence and root visibility for interactive reads, including search, permalinks, attachment reads, reactions, mentions, pins, and event records. Existing tasks, projects, knowledge pages, runs, audit records, and their related history also inherit the membership cutoff, so an old artifact cannot reveal earlier group context through a different view. Worker projections explicitly intersect requester and agent history access; task recurrence and reminder workers recheck source history grants. Offboarding and group departure remove drafts, cancel scheduled composition, and retain attribution without restoring old grants.

## Long views and verification

Main and thread timelines use measured TanStack virtualization above 80 loaded messages, while older/newer navigation continues to use the existing history API. Stable message keys and explicit anchor navigation support loading older history and following a permalink without mounting the entire loaded timeline.

Agent, member, invitation, knowledge, audit, run, and approval collections expose bounded keyset pages through `/v1/collections/<kind>`. Cursors bind the workspace, viewer, and collection and retain PostgreSQL timestamp precision. The UI offers load-more controls and revalidates the loaded range on relevant refreshes. Personal collections and channel discovery also use cursor pagination. Large-fleet load and accessibility qualification remain operational release work; pagination and virtualization are not a claim of completed fleet-scale testing.
