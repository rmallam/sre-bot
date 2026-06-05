# DevOps Agent Phases (A–G)

The SRE bot extends beyond Kubernetes remediation into CI/CD and observability while keeping the same pattern: **commander → orchestrator LangGraph → typed tools → agents** (no raw GitHub/kubectl access for the LLM).

**Master backlog:** [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md) · Holmes patterns: [HOLMES-COMPARISON-AND-ADOPTION.md](./HOLMES-COMPARISON-AND-ADOPTION.md)

## Phase A — CI/CD read + triage ✅

**Goal:** Answer “why did CI fail?” with structured facts and a diagnosis.

| Component | Role |
|-----------|------|
| `cicd-agent` | GitHub Actions API: fetch run, jobs, log excerpt |
| `shared/ci-diagnose.ts` | Classify failure kind, suggest action |
| `shared/ci-plan.ts` | Build `RemediationPlan` for `ci-failure` mode |
| Orchestrator `observe` | `gatherCiFacts()` instead of K8s facts |
| Orchestrator `plan` | `buildCiRemediationPlan()` (no brain LLM) |

**Try:** `why did CI fail on github.com/org/repo`

## Phase B — CI/CD act (rerun, open issue) ✅

**Goal:** After triage, optionally re-run the workflow or open a tracking issue.

| Action | Tool | HIL |
|--------|------|-----|
| `cicd_rerun` | `cicd.rerun_workflow` | Default: yes (`low_risk_only`) |
| `cicd_open_pr` | `cicd.open_pr` | Opens GitHub issue (placeholder for automated PR) |
| `noop` / `escalate_human` | notify only | Report-only or human handoff |

Security allow-list includes `cicd_rerun` and `cicd_open_pr`.

## Phase C — GitHub webhook + skills ✅

**Goal:** Auto-react to failed workflows; inject team runbooks into brain prompts.

| Feature | Config |
|---------|--------|
| Webhook | `POST /webhooks/github` on commander |
| Signature | `GITHUB_WEBHOOK_SECRET` |
| Notify channel | `GITHUB_WEBHOOK_NOTIFY_CHANNEL_ID` or `TELEGRAM_ALERT_CHAT_ID` |
| Skills | Platform RAG (`POST /rag/query`) — verified runbooks injected into brain system prompt |
| Auto skill export | Console **Export skills** (**PLAT-8a** done); auto-write pending (**PLAT-8b**) |

GitHub repo → Settings → Webhooks → `workflow_run` events → payload URL above.

## Phase D — Observability (Loki / Prometheus) — **PLAT-4** ✅ core

**Goal:** Holmes-style **investigation breadth** without LLM MCP — investigator plugins fetch facts; brain still plans only.

See **[DEEP-RCA.md](./DEEP-RCA.md)** for architecture.

| Endpoint | Backend |
|----------|---------|
| `GET /facts` | K8s + specialists + Loki + Prom → `rcaPointers[]` |
| `POST /observability/logs` | `LOKI_URL` or K8s pod logs fallback |
| `POST /observability/metrics` | `PROMETHEUS_URL` workload metrics bundle |

Orchestrator tools: `investigator.logs_query`, `investigator.metrics_query`.

**Env:** `LOKI_URL`, `PROMETHEUS_URL`, `DEEP_RCA_ENABLED=true`

## Phase E — Alert ingress — **PLAT-7**

**Goal:** Start runs from external alert systems (Holmes-style ingress, sre-bot remediation loop).

| Source | Flow |
|--------|------|
| AlertManager | Webhook → commander → `POST /runs` |
| PagerDuty / OpsGenie | Optional webhook adapters |
| GitHub `workflow_run` | **Done** (Phase C) |

## Phase F — Operator-style proactive checks — **PLAT-6**

**Goal:** Scheduled health checks beyond K8s Warning events (Holmes operator pattern).

| Feature | Implementation |
|---------|----------------|
| Cron / CRD health check | Periodic `POST /runs` with `mode: diagnose` |
| Post-deploy verification | Hook after pre-deploy success |
| Multi-datasource checks | After Phase D (Prom/Loki queries in check definition) |

## Phase G — Platform hygiene — **PLAT-2, PLAT-3**

| Feature | Purpose |
|---------|---------|
| Run deduplication | Skip new run if resource already `running` / `awaiting_human` |
| Watcher cooldown normalization | Single key per workload (Pod → Deployment owner) |

---

## Environment summary

```bash
GITHUB_TOKEN=
GITHUB_WEBHOOK_SECRET=
LOKI_URL=
PROMETHEUS_URL=
SRE_RAG_GROUNDING=true
SRE_RAG_LEARNING=true
CICD_URL=http://cicd-agent:8080
GEMINI_COMMANDER_MODEL=gemini-2.5-flash
```

## Status

| Phase | Status |
|-------|--------|
| A | ✅ Shipped |
| B | ✅ Shipped |
| C | ✅ Shipped |
| D | ✅ Core shipped ([DEEP-RCA.md](./DEEP-RCA.md)) |
| E | Pending (**PLAT-7**) |
| F | Pending (**PLAT-6**) |
| G | Pending (**PLAT-2**, **PLAT-3**) |
