# Local development stack

Start everything with Docker Desktop running:

```sh
npm run local:up
```

The first run downloads the pinned containers and about 2.2 GB of model weights. Later runs reuse them. The app and workers run as loopback Node processes; supporting services run in project-scoped Docker containers.

- Landing page: http://localhost:3000
- Workspace and signup: http://localhost:3000/app
- API health: http://127.0.0.1:4000/health
- Agent runtime health: http://127.0.0.1:4100/eve/v1/health
- Captured email inbox: http://localhost:8025
- Ollama: http://127.0.0.1:11435
- ClamAV: 127.0.0.1:3310

Create a workspace in the app, then open Mailpit and follow its verification email. Invitation, verification and password recovery email is captured locally; no Gmail/Resend credentials or owned domain are needed. Existing accounts and workspaces remain in the persistent embedded PostgreSQL database under `.data/postgres`. Existing attachments remain in `.data/files`. This launcher does not replace that database with a fresh Docker database or move files to a new bucket.

## Local AI and isolated execution

Docker Ollama runs with cloud inference disabled. `orbit-chat` is a local alias for Qwen2.5 3B with a 16,384-token context. `orbit-embeddings` uses Nomic Embed Text v1.5. Hosted agents and model-written cited answers use the local chat model; vector retrieval uses local embeddings. No AI Gateway key is passed to those calls. These small models support functional testing; quality and speed differ from hosted frontier models. Existing agents pinned to cloud model names need an explicit local model revision or `operator_default` before they can run in this profile.

Local code execution supports JavaScript, Python, shell and isolated in-memory SQLite through approved `execute_code` proposals. The executor uses pre-pulled immutable Docker image IDs, a read-only root filesystem, no host mounts or host secrets, no network, an unprivileged user, dropped capabilities, bounded CPU/memory/PIDs/output and forced deadline cleanup. This provider is rejected in production; production keeps the separately configured microVM backend. It does not weaken the existing approval, capability or action-ledger checks.

ClamAV scans real uploaded bytes. LiveKit, Redis and Egress now provide local calls and recording without a paid media service; see [calls and notification delivery](calls-and-delivery.md). Egress adds a container download and can use four CPUs/4 GB memory. PDF/image OCR, live OAuth/connector accounts and external calendar synchronization remain separate configuration; Docker does not impersonate Slack, Teams, Stripe or other vendors.

## Lifecycle

```sh
npm run local:status
npm run local:verify
npm run local:down
```

Restart one app service after changing server code, without restarting Docker
dependencies or changing stored accounts:

```sh
node scripts/local.mjs restart api
```

Use `web` or `runtime` in place of `api` to restart those processes. API startup
applies pending local database migrations. If an older installation returns
`PERMISSION_DENIED` during sign-in, restart the API to apply the identity-role
workspace-liveness repair. Account creation still requires the verification
email in Mailpit; an existing email address should be used to sign in rather
than registered again.

`local:verify` checks runtime authentication/session lifecycle, local email verification/invitations/password recovery, actual local embeddings, a schema-validated hosted agent turn and Docker sandbox languages, secret/network isolation, output bounds and cleanup. It uses synthetic input and a disposable email test database; existing accounts are not changed. `local:down` stops only processes recorded by this launcher and this project's supporting containers. It preserves database, files, inbox and model volumes, and leaves unrelated Docker projects and the machine's pre-existing Ollama service alone.

After changing managed-agent code, stop and start the local stack to rebuild it. The web app runs in Next development mode. Restart the API after changing server code.

The root `.env` is preserved. Generated local overrides and the runtime service token live in `.data/local/environment` with mode 0600; the launcher reuses its secret on restart. API/runtime/web logs, model setup logs and owned process metadata live under `.data/local/`. These files are ignored by Git. Do not publish or paste the private environment file. If Docker is stopped, start Docker Desktop before running the launcher.

Provider setup follows the installed [eve local-model guide](../node_modules/eve/docs/agent-config.md), [Ollama local API](https://docs.ollama.com/api/openai-compatibility), and [Ollama Docker instructions](https://docs.ollama.com/docker). Container ports bind to loopback only. Real production credentials, durable recovery qualification and live provider acceptance remain separate deployment work.

## Repository checks

Run `npm run lint:unused`, `npm run typecheck`, `npm run format:check`, and `npm run api:check` before committing. `npm run check` also runs the unused-code audit, API tests, and production builds. CI runs the unused-code audit with configuration hints treated as errors.

`knip.json` records entry points launched by Docker, the managed runtime, browser service workers, operational commands, and documented examples. Package entry points preserve the public SDK and contract exports. Register new independently launched entry points there instead of suppressing unused-file reports. The Expo security test has a scoped exception for inspecting Expo-owned transitive dependencies; it resolves them from the mobile workspace and the certificate package that actually uses them.

Git and Docker ignore local environments, credentials, caches, generated bundles, logs, test reports, and native signing outputs. The two synthetic SAML fixture certificates remain included so federation tests work from a fresh checkout. Keep `package-lock.json`, migrations, configuration templates, and application sources in version control.
