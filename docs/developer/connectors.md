# Connector and MCP authoring

Orbit has three explicit integration contracts:

1. Native catalog connectors with fixed provider request builders, OAuth handlers, resource grants, and operation-specific reconciliation. Their operation coverage and validation limits are documented in `docs/retrieval-and-connections.md`.
2. Generic action adapters using the existing `/actions/{idempotencyKey}` protocol. A POST must durably deduplicate its key. A GET returns a bounded read-only receipt (`succeeded`, `not_applied`, `unknown`). Register exact operations, effects and owner grants. Adapters are not arbitrary credential-forwarding HTTP proxies.
3. Remote MCP servers using the official TypeScript client and Streamable HTTP transport. Configure their exact public HTTPS host in `REMOTE_MCP_HOSTS`. Endpoint paths are fixed; credential destinations, redirects and automatic remote OAuth discovery are refused. Owners can supply and rotate a server token; Orbit's public OAuth server is a separate inbound identity boundary.

## Remote MCP lifecycle

Create a remote connection in Developer, select its conversations, and discover its tools. Discovery is bounded to 100 unique tools, five pages, a 128 kB response and a global exchange deadline. Input schemas and descriptions are untrusted source material. Descriptions are displayed as text, not interpreted as instructions or HTML.

No discovered operation is enabled automatically. An owner selects up to 30 tools and explicitly classifies each effect. Remote `readOnlyHint`, `destructiveHint` or `idempotentHint` annotations cannot authorize writes. Orbit publishes local aliases (`mcp_0`, etc.) and retains the exact remote names and reviewed schemas. Grant the selected aliases separately to the human requester and agent, with expiry. The source conversation must be included in the connection grant.

An agent proposes `connection_action` with `connectionId`, the published alias, and an object serialized in `payload`. Schema compilation/validation runs in an isolated, memory/time-bounded worker because schemas may contain expensive regular expressions or recursion. Approval captures connection version, owner, destination, operation and effect. Short-lived execution capabilities and the normal action ledger govern dispatch.

Immediately before a call, Orbit discovers the current tool and compares its canonical schema/description to the reviewed manifest. Key ordering differences introduced by PostgreSQL JSONB do not invalidate equivalent manifests. The final guard checks run authority, grants, approval, capability expiry and action state. Refreshing a manifest or rotating credentials increments the connection version and invalidates previous approvals. Publishing a new selection also revokes old consumer grants.

MCP has no universal write idempotency or read-only reconciliation contract. Orbit sends an advisory action ID in `_meta`, dispatches once, and leaves interrupted/uncertain calls unresolved. It never retries a remote tool call as reconciliation. A server `isError` response does not prove a side effect was absent. Successful responses produce bounded digest receipts; arbitrary remote response bodies and credentials are not copied into model context or public traces. Rich remote-result ingestion needs an explicit provenance/audience mapping rather than automatic forwarding.

## Provider qualification checklist

For each native connector or remote server, use a provider test account to verify: exact requested scopes; refresh/expiry/revocation; owner/requester/agent grants; each documented resource and operation; malformed input and pagination; rate limits; transport interruption after commit; webhook signatures and duplicate handling; schema/version changes; deletion and revocation propagation; and credential redaction. Record unsupported operations explicitly.

The local suites exercise real domain authorization, action ledgers, SDK protocol exchange and network boundaries with disposable servers/stub providers. They do not certify live third-party accounts, remote authorization servers or every operation a server advertises.
