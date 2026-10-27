# Account and organization management

Orbit keeps account identity separate from organization membership and workspace content. An organization contains multiple workspaces; every workspace retains its existing forced PostgreSQL tenant boundary. Migration `034_organizations_identity.sql` backfills one organization per existing workspace, preserves account and content IDs, and enrolls existing human members. Workspace organization and region cannot be changed by an ordinary row update.

Open **Settings & activity** for account security and organization management. **Team → Manage** contains workspace access policies, ownership transfer, and offboarding. These features use the persistent API and database, including in local Mailpit mode. No paid identity provider is required for local account, organization, MFA, guest, or service-account management.

## Account identity and sessions

- Edit the display name, IANA time zone, and language. Display-name changes update the account's workspace memberships while preserving historical author IDs.
- Change passwords with the current password and, when enabled, a fresh authenticator or recovery code. Password changes invalidate all sessions, pending account proofs, and sign-in challenges.
- Request an email change with the same proof. The current address remains active until the new mailbox confirms a one-use, hashed, 30-minute proof. Confirmation rechecks organization domain policy, updates the verified address, and invalidates all sessions. The link uses `/change-email#…`; the fragment is removed from browser history before submission. Requests use the existing encrypted email outbox and Mailpit/Gmail/Resend transports.
- List devices/sessions without exposing bearer secrets or token hashes. Revoke one session, sign out the current session, or revoke other sessions after credential proof. Session records include creation, activity, expiry, authentication method, MFA assurance, user agent, and IP address. Workspace switching preserves the original authentication age and device metadata; switching or invitation acceptance cannot renew an expired organization authentication lifetime. Destination organization administration also checks its own session lifetime rather than inheriting a more permissive workspace policy. The application does not trust forwarded IP headers by default.
- Account sessions can exist without a selected workspace. An offboarded person can authenticate, manage their own account, create a new organization, or accept a different invitation. These sessions return `WORKSPACE_REQUIRED` for tenant content and cannot recover a revoked workspace grant.

Workspace switching rotates the cookie. It carries authentication provenance, then checks the destination's membership, domain policy, and SSO provider binding. An IdP session for one organization cannot satisfy another organization's SSO policy. Policies are also checked against the organization named by an administration request; selecting a less restrictive workspace does not bypass them.

## Organizations, domains, and regions

Organization owners can create workspaces, grant organization administrator/member roles to people who have joined through an invitation, explicitly add workspace access, transfer organization ownership, and offboard or restore members. Organization administrator privileges and workspace administrator privileges are distinct. Organization ownership transfer demotes the transferring owner to organization administrator. Workspace ownership transfer is separate and likewise preserves an active owner.

Owners can set:

- Allowed member email domains. Each domain requires a matching TXT record at `_orbit-verification.<domain>`. Claims expire after seven days if unverified; records are compared using a stored proof hash. Domain ownership is globally unique. Guests may use external addresses, but remain limited to explicitly shared conversations.
- Allowed workspace regions, required MFA, required SSO, and a session lifetime of 1–168 hours. Policy edits use optimistic versions. Existing workspaces must fit the allowed region set. Owners must enable MFA and demonstrate a successful configured SSO session before requiring those methods organization-wide.

`DEPLOYMENT_REGION` declares this deployment's geography (`global`, `us`, `eu`, `in`, or `ap`). Workspace creation must match both that region and organization policy. A request for another region fails with `REGION_DEPLOYMENT_REQUIRED`; it does not pretend to create a remote tenant. Operators must provision the API, PostgreSQL, backups, execution runtime, and object storage in the intended geography. The code enforces assignment rules; physical residency, cross-region routing/migration, regional disaster recovery, and independent residency qualification remain deployment work.

Organization administration writes attributed audit records, including the credential ID for SCIM operations. Workspace changes continue to use workspace audit/outbox publication and current-access checks. Organization/identity tables are inaccessible to the content runtime role; the trusted identity role authorizes the requested organization and account before querying them.

## MFA

MFA uses the maintained `otplib` TOTP implementation with six-digit authenticator codes, a 30-second step, and bounded clock tolerance. Setup expires after ten minutes and requires the current password. Confirmation verifies the code, encrypts the seed with AES-256-GCM, hashes ten random one-use recovery codes, revokes old sessions, and issues a new session cookie with MFA assurance. Setup keys and recovery codes are shown only during the corresponding operation; the browser does not persist them.

Password sign-in for an MFA account issues an HttpOnly five-minute challenge cookie, not an authenticated session. Challenge attempts are persisted and limited to five. Verification locks the account and MFA row before consuming a TOTP step or recovery code, preventing replay and concurrent reuse. Disabling MFA and replacing recovery codes require the current password plus a fresh second factor. Organization-required MFA cannot be disabled.

Set `IDENTITY_ENCRYPTION_KEY` to a stable canonical base64-encoded 32-byte key, generated privately with `openssl rand -base64 32`. The server can fall back to the existing `EMAIL_ENCRYPTION_KEY` for local compatibility. Context-bound authenticated encryption prevents moving encrypted seeds, provider secrets, or PKCE verifiers between identities. Keep the key in a server secret manager and identical across replicas. Replacing it without re-encryption makes existing encrypted identity secrets unavailable; do not rotate it casually or put it in a public browser variable.

## Federated login and enterprise SSO

An organization owner configures an OIDC or SAML provider in Settings. Configure exact hostnames through `IDENTITY_PROVIDER_HOSTS` before adding providers. OIDC discovery, token, and JWKS requests validate every URL against that allowlist, reject non-HTTPS/private-network destinations and redirects, pin validated DNS answers through the HTTP connection, and have a bounded timeout. Include each distinct hostname used by your IdP. The loopback exception is only an injected test option and is rejected in production.

The connection panel displays the callback URL:

```text
https://<web-origin>/api/v1/auth/federation/<provider-id>/callback
```

For SAML, the service-provider entity ID and metadata URL are:

```text
https://<web-origin>/api/v1/auth/federation/<provider-id>/callback/metadata
```

OIDC uses `openid-client` discovery and authorization-code exchange with S256 PKCE, state, nonce, signature/issuer/audience/expiry checks, and a required verified email claim. Configure the IdP client for `client_secret_post`. Access/refresh tokens are not retained by the application; this connection provides identity authentication rather than authorization to external business tools.

SAML uses `@node-saml/node-saml` with a pinned, currently valid IdP signing certificate, expected IdP issuer, destination, audience, assertion lifetime, and mandatory `InResponseTo`. Both the response and assertion must be signed. Configure a persistent NameID and an `email` attribute. Only SP-initiated login is accepted. The IdP must permit unsigned authentication requests; signed AuthnRequests, encrypted assertions, IdP-initiated login, and federated single logout are not advertised by this implementation.

Both protocols use hashed, browser-bound, five-minute state stored in PostgreSQL and consumed before validating a callback. SAML request IDs are durable and bound to the exact login state, and one-use state serializes concurrent callbacks across replicas. Linking state is bound to a still-valid source session; a dedicated secure SameSite=None callback cookie supports cross-site SAML POSTs without depending on the normal Lax session cookie. Production federation requires HTTPS.

An existing account must explicitly choose **Link & sign in** while authenticated. Matching an email address alone never links an existing global account. Provisioning from a verified domain is explicitly opt-in per provider and disabled by default. Linking never grants membership by itself: users need an invitation or SCIM grant unless that owner-controlled provisioning option is enabled. JIT creation additionally requires an organization-verified domain. Directory-created accounts have a narrower first-login path: the account must have been created by that organization, the SCIM external ID must match the verified provider subject, the domain must be verified, and an active provisioning group must have granted an organization workspace. Login prefers an authorized default workspace and otherwise selects an already-authorized workspace in the same organization. Manually existing accounts retain explicit linking. MFA-enabled accounts still complete local MFA after provider authentication.

Find sign-on providers from **Sign in → Find single sign-on**, using a verified organization email domain or the organization ID. Disabling a provider invalidates its sessions and pending state. Required SSO cannot lose its last provider, and the owner must retain another linked provider before disabling a required connection. To rotate IdP credentials/certificates, configure a replacement connection, link and test it, then disable the old one.

Real customer IdPs need their own client registration, hostname allowlist, certificate/secret configuration, and acceptance testing. Local signed protocol fixtures validate the implementation; no live customer IdP is provisioned automatically.

## Guests, service accounts, and capabilities

Guest invitations specify a member role and at least one shared channel/group. Workspace owners can convert a full member to a guest after transferring project ownership and unscoped task assignments. Guests do not receive implicit access to public conversations, workspace-wide tasks, knowledge, projects, or files. Restrictive PostgreSQL RLS policies apply to their content and related history even if an application query omits its audience filter. Guests cannot create DMs/groups, administer workspace security, or start hosted execution.

Per-member capability overrides cover message, task, knowledge, file, project, people, agent, execution, and workspace actions. Capability checks are centralized at the authenticated route boundary. Resource ownership, human-verification requirements, administrator roles, active membership, and conversation access still apply; a capability does not bypass them. Access changes revoke workspace sessions and fence open hosted work. Recurring workers recheck current capability and source access before creating occurrences.

Workspace owners can issue dedicated service principals with explicit supported capabilities, selected conversations, and a 1–365-day expiry. Only a hash of the one-time-displayed bearer token is stored. Service accounts have no human session and cannot administer identity or hosted execution. They share the restricted database audience boundary with guests. Revocation invalidates the credential and suspends the principal. Issue a replacement credential and revoke the old one to rotate access; the original credential is never revealed again.

External AI agents track both their human custodian and the person who last received a bearer credential. Administrators can rotate an external agent credential from the Agents view; rotation immediately invalidates the previous key, cancels open execution, and pauses the agent until its runtime is reconfigured and resumed. Offboarding or administrator demotion revokes issued service/provisioning credentials, invalidates affected agent keys, pauses affected agents, and transfers custody to an explicit successor. Historical agents are backfilled from creation audit events; agents without attributable custody are conservatively paused and invalidated on a departure. Legacy external keys do not have automatic expiry; use expiring service accounts for machine access that requires a fixed lifetime.

## SCIM 2.0

Organization owners issue expiring, revocable SCIM bearer tokens. The UI displays each token once. The base URL is:

```text
https://<web-origin>/api/scim/v2/<organization-id>
```

Implemented resources include `ServiceProviderConfig`, `ResourceTypes`, `Schemas`, `Users`, and `Groups`; individual discovery resources; User/Group GET, POST, PUT, PATCH and DELETE; ETag/If-Match updates; stable pagination; attribute selection; supported equality filters; and SCIM JSON/error envelopes. Supported filters are `userName eq`, `externalId eq`, `id eq`, and `displayName eq`. Unsupported filters fail explicitly with `invalidFilter`. Bulk, sorting, and SCIM password changes are advertised as unsupported.

Provisioning modifies organization access and organization display names, not another tenant's global profile or credentials. `userName` changes use the user's verified email-change flow. Deactivation atomically offboards all organization workspace memberships, revokes organization-bound sign-in state, removes directory groups/identity links, and retains attribution. Owners must transfer organization/workspace ownership before last-owner deprovisioning. DELETE creates a tombstone that is absent from SCIM reads; reprovisioning does not revive old sessions or private shares.

Map groups to a workspace through the Settings group-mapping form or this Group extension:

```json
{
  "schemas": [
    "urn:ietf:params:scim:schemas:core:2.0:Group",
    "urn:orbit:params:scim:schemas:extension:workspace:2.0:Group"
  ],
  "displayName": "Engineering",
  "members": [{ "value": "<scim-user-id>" }],
  "urn:orbit:params:scim:schemas:extension:workspace:2.0:Group": {
    "workspaceId": "<organization-workspace-id>"
  }
}
```

Removing the last provisioning group for a workspace offboards only provisioning-managed membership; it preserves pre-existing/manual membership. Explicit manual workspace assignment takes ownership of that grant. SCIM custodial project reassignment preserves the original conversation audience, so it never grants a custodian access to private messages. Closed/inaccessible retained projects may require review by an already-authorized participant.

## Offboarding and restoration

Workspace offboarding checks an optimistic member version and current administrator authority under a workspace lock. It:

1. Preserves an active owner, promoting an eligible explicit successor when needed.
2. Transfers project ownership and assigned tasks to an eligible successor, or unassigns tasks when no successor is selected. Manual transfers require the successor to already have the relevant private access.
3. Cancels open requester and affected owned/issued-agent runs, clears execution leases, and cancels pending/approved tool invocations; pauses those agents and invalidates external keys even if someone later resumes them.
4. Pauses recurring work created by the departing member.
5. Transfers group ownership when an active human participant remains, and removes conversation shares.
6. Revokes workspace sessions, service credentials issued by or for the departed member, and their organization provisioning credentials; cancels outstanding invitations and queued invitation email.
7. Suspends the membership, records offboarding time, and publishes committed invalidations while retaining messages, task history, knowledge attribution, and audit evidence.

Organization offboarding applies those changes across its workspaces in one transaction and suspends organization membership. It leaves unrelated organizations intact. Reassignment failures roll back the entire operation. Restoration is explicit: restore organization membership, then assign workspace access. Old sessions, group shares, directory links, and credentials stay revoked.

Provider business connections and cross-product automations are separate future modules. This implementation fences all currently implemented identity, task, collaboration, and hosted-execution resources; it does not claim to revoke third-party connections that do not exist yet.

## Verification and operating limits

The API suites exercise profile and verified-email changes, session ownership, MFA setup/cookie rotation/challenge limits/recovery replay, domain proof, policy versions, workspace isolation, guest RLS without application filters, capability denial, scoped credentials, ownership safeguards, offboarding/re-invitation, and SCIM lifecycle/mappings. OIDC tests use a real local authorization server with signed ID tokens and PKCE. SAML tests use signed response/assertion fixtures and cover issuer/audience/request correlation, tampering, replay, and cross-site callback behavior without the ordinary session cookie. Browser tests cover profile/organization/credential administration, MFA enrollment and recovery sign-in, guest conversion, offboarding, and the full provider-linking and OIDC redirect sign-in flow. These run through the existing embedded, PostgreSQL, and production-browser CI jobs.

A bounded identity sweep removes expired sessions, sign-in state/challenges, SAML request IDs, and unconfirmed MFA seeds. Expiry is enforced before the sweep during authorization.

Per-route IP rate limiting remains process-local, while MFA challenge attempts, proof cooldowns, token consumption, sessions, state, and revocation are durable. A multi-replica public deployment still needs a shared abuse limiter, configured trusted proxies, key-management procedures, retention/deletion policy, independent security assessment, and qualification with each chosen IdP. Security-notice email, bounce/complaint webhooks, passkeys/WebAuthn, and complete account erasure are separate release work.
