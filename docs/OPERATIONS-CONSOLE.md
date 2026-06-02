# Operations Console

The **Operations Console** is the primary web UI for managing SRE Bot incidents, approvals, autonomous runs, and ignored resources. It complements Telegram/Slack — actions taken in either place sync automatically.

**URL (compose):** http://localhost:8091

## Features

| Area | What you can do |
|------|-----------------|
| **Overview** | At-a-glance stats, agent health, recent runs, pending approvals |
| **Approvals** | Approve, reject, ignore, or suggest your own fix for each incident |
| **Resources** | Grouped by workload — suggested fix, worked?, actions taken, skill export |
| **Run detail** | Full remediation outcome, tool timeline, cancel in-flight runs |
| **Ignored** | View suppressed resources; unignore when ready to remediate again |

### Dual-channel workflow

- Approve on **Telegram** → card disappears from console within ~5s (Live mode).
- **Ignore** on web → watcher/orchestrator skip that resource; Telegram cards stop for it.
- **Suggest fix** works the same on both channels (rules + brain LLM parse).

### Skill compilation

Each remediation attempt records a structured **outcome** (root cause, suggested fix, actions taken, whether it worked). Use **Copy skill snippet** on an attempt or **Export skills** to copy markdown suitable for `skills/` runbooks (loaded by brain via `CICD_SKILLS_DIR`).

Older runs without persisted outcomes show best-effort data derived from tool transcripts.

### Roadmap (pending)

See [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md) Track B:

| ID | Feature |
|----|---------|
| **CON-2** | Auth (OAuth / basic / SSO proxy) |
| **CON-3** | Keyboard shortcuts for approve/reject |
| **CON-4** | Unified activity feed (Telegram + web + HIL) |
| **CON-5** | Default “latest attempt only” on Resources page |

Toggle **Live** in the top bar for 5-second polling. Pause to reduce API load (30s background refresh on overview pages).

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

## Legacy HIL dashboard

The original HTML dashboard remains at http://localhost:8085/legacy for backward compatibility. New users should prefer the Operations Console.

## Architecture

```
Browser → console-agent (Express BFF + static React)
              ├── GET/POST /api/* → hil-agent
              └── GET/POST /api/runs/* → orchestrator-agent
```

The UI never talks to agents directly — the BFF handles auth boundaries and consistent error shapes for the SPA.
