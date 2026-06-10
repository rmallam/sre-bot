# Operations Console

The **Operations Console** is the primary web UI for managing SRE Bot incidents, approvals, autonomous runs, and ignored resources. It complements Telegram/Slack — actions taken in either place sync automatically.

**URL (compose):** http://localhost:8091

## Features

| Area | What you can do |
|------|-----------------|
| **Overview** | At-a-glance stats, agent health, recent runs, pending approvals |
| **Applications** | App dependency graph, component health, investigate/fix links |
| **Activity** | Unified timeline of runs + HIL approvals (all channels) |
| **Approvals** | Approve, reject, ignore, or suggest your own fix for each incident |
| **Runs** | Grouped by workload — suggested fix, worked?, actions taken, skill export |
| **Run detail** | Full remediation outcome, tool timeline, cancel in-flight runs |
| **Ignored** | View suppressed resources; unignore when ready to remediate again |
| **Assistant** | Conversational chat with the SRE agent |

### Dual-channel workflow

- Approve on **Telegram** → card disappears from console within ~5s (Live mode).
- **Ignore** on web → watcher/orchestrator skip that resource; Telegram cards stop for it.
- **Suggest fix** works the same on both channels (rules + brain LLM parse).

### Skill compilation

Each remediation attempt records a structured **outcome** (root cause, suggested fix, actions taken, whether it worked). Use **Copy skill snippet** or **Export skills** to copy markdown — add to the vector store via platform `POST /rag/learn` or the bootstrap script (see `skills/README.md`).

Older runs without persisted outcomes show best-effort data derived from tool transcripts.

### Shipped (console)

| ID | Feature |
|----|---------|
| **CON-2** | OIDC SSO login, HTTP-only session cookies, namespace RBAC (group → namespace map) |
| **CON-3** | Keyboard shortcuts on Approvals — **A** approve, **R** reject, **I** ignore, **J/K** navigate |
| **CON-4** | **Activity** tab — unified run + approval timeline |
| **CON-5** | Runs page shows **latest attempt only** by default |

Toggle **Live** in the top bar for 5-second polling. Pause to reduce API load (30s background refresh on overview pages).

## Authentication (CON-2)

Local dev runs with auth **disabled** (open access). For production:

```bash
CONSOLE_AUTH_ENABLED=true
CONSOLE_COOKIE_SECURE=true
OIDC_ISSUER=https://your-idp.example.com/realms/sre
OIDC_CLIENT_ID=sre-console
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=https://console.example.com/api/auth/callback
CONSOLE_NAMESPACE_RBAC={"team-a":["ns-a","ns-b"],"admins":["*"]}
```

Multi-replica console: set `CONSOLE_SESSION_BACKEND=redis` and `REDIS_URL=...`.

Secondary HIL enforcement (optional): `HIL_ENFORCE_CONSOLE_RBAC=true` — hil-agent validates namespace headers from the console BFF on web approve/reject.

## Local development

```bash
cd agents/console
npm ci

# Terminal 1 — BFF + API proxy
PORT=8091 npm run dev:server

# Terminal 2 — Vite dev server (proxies /api → :8091)
npm run dev:web
```

Open http://localhost:5173 for hot reload. Production build:

```bash
npm run build:web
PORT=8091 npm start
```

## Docker

The `console-agent` service in `docker-compose.yml` builds the React UI and serves it from the Express BFF on port **8091**.

```bash
./scripts/compose-up.sh
# or: podman compose up --build console-agent
```

Environment:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HIL_URL` | `http://hil-agent:8080` | Approvals, ignore list |
| `ORCHESTRATOR_URL` | `http://orchestrator-agent:8080` | Runs, summaries, cancel |
| `COMMANDER_URL` | `http://commander-agent:8080` | Agent health probe |
| `CONSOLE_AUTH_ENABLED` | `false` | Enable OIDC login |
| `CONSOLE_SESSION_BACKEND` | `memory` | `redis` for multi-replica sessions |
| `CONSOLE_NAMESPACE_RBAC` | — | JSON group → namespaces map |

## Legacy HIL dashboard

The original HTML dashboard remains at http://localhost:8085/legacy for backward compatibility. New users should prefer the Operations Console.

## Architecture

```
Browser → console-agent (Express BFF + static React)
              ├── OIDC login/callback → HTTP-only session cookie
              ├── GET/POST /api/* → hil-agent (namespace RBAC headers)
              └── GET/POST /api/runs/* → orchestrator-agent
```

The UI never talks to agents directly — the BFF handles auth boundaries and consistent error shapes for the SPA.
