# Product Roadmap

Consolidated engineering backlog for **sre-bot**. Domain-specific details live in linked docs; this file defines **priority**, **status**, and **cross-track dependencies**.

Related:

- [HOLMES-COMPARISON-AND-ADOPTION.md](./HOLMES-COMPARISON-AND-ADOPTION.md)
- [CONVERSATIONAL-UX-ROADMAP.md](./CONVERSATIONAL-UX-ROADMAP.md)
- [CI-CODE-REMEDIATION-ROADMAP.md](./CI-CODE-REMEDIATION-ROADMAP.md)
- [DEVOPS-AGENT-PHASES.md](./DEVOPS-AGENT-PHASES.md)
- [OPERATIONS-CONSOLE.md](./OPERATIONS-CONSOLE.md)
- [LLM-AND-MCP.md](./LLM-AND-MCP.md)
- [PLATFORM-LAYERS.md](./PLATFORM-LAYERS.md)

---

## Design principle (unchanged)

```text
User ↔ Commander (natural language)
         ↓ structured intents / run updates
       Orchestrator + typed tools (no LLM cluster access)
         ↓ sanitized facts
       Brain plans → Security authorizes → HIL → Act → Verify
```

Do **not** replatform on Holmes-style LLM MCP writes. Adopt Holmes **investigation patterns** via investigator plugins.

---

## Recommended implementation order

| Order | ID | Item | Impact |
|-------|-----|------|--------|
| 1 | **PLAT-1** | NL routing — Gemini commander model fix | Unblocks chat UX |
| 2 | **PLAT-2** | Run deduplication (skip if resource already in-flight) | Less noise in console |
| 3 | **PLAT-3** | Watcher cooldown key normalization (Pod → workload) | Fewer duplicate runs |
| 4 | **CI-2** | Coding agent service (Phase 2) | Application-code CI failures |
| 5 | **PLAT-4** | Observability investigator plugins (Prom / Loki) | Holmes-style RCA, our security model |
| 6 | **PLAT-5** | Console auth (SSO or basic) | Production console exposure |
| 7 | **PLAT-6** | Operator-style scheduled health checks | Proactive beyond K8s events |
| 8 | **PLAT-7** | Alert ingress (AlertManager → commander) | Alert-driven runs |
| 9 | **PLAT-8** | Auto-sync skills to `skills/` on successful outcomes | Learning loop |
| 10 | **CI-3** | Post-PR CI verify + notify | Close CI remediation loop |
| 11 | **PLAT-9** | Large log/metric payload filtering | Scale investigator/cicd |
| 12 | **PLAT-10** | Additional backends (Datadog, Tempo) | Optional breadth |
| 13 | **PLAT-11** | Read-only debug MCP profile (human-only) | Optional power-user |
| 14 | **PLAT-12** | Hybrid RCA handoff (external summary → orchestrator) | [Design ready](./RCA-HANDOFF-SCHEMA.md) |
| 15 | **DEPLOY-2** | Source-to-image / buildpack deploy pipeline | [SOURCE-TO-IMAGE-DEPLOY.md](./SOURCE-TO-IMAGE-DEPLOY.md) Phase 1 |

---

## Track A — Platform reliability & noise reduction

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-1** | **Natural language routing** — `GEMINI_COMMANDER_MODEL=gemini-2.5-flash`, compose default, `/health` LLM summary | **Done** | `gemini-2.0-flash` returned 404; broke LLM intent. Rebuild `commander-agent`. |
| **PLAT-2** | **Run deduplication** — reject/skip `POST /runs` if same `namespace/resource` has `running` or `awaiting_human` | **Done** | `orchestrator /runs` now returns `deduplicated=true` with existing run info |
| **PLAT-3** | **Watcher cooldown normalization** — resolve Pod → owner Deployment for single cooldown key; dedupe event watch vs pod poll | **Done** | Watcher cooldown now keys by normalized workload name |
| **PLAT-13** | **Orchestrator “active run” index** — optional Redis/Postgres lookup by resource key | Pending | Supports PLAT-2 at scale |

**Env (PLAT-1):**

```bash
LLM_PROVIDER=gemini          # or openrouter
GEMINI_API_KEY=...
GEMINI_COMMANDER_MODEL=gemini-2.5-flash
OPENROUTER_COMMANDER_MODEL=google/gemini-2.5-flash  # if using OpenRouter
```

---

## Track B — Operations Console

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **CON-1** | Grouped resources + remediation outcomes + skill export | **Done** | `/resources`, `remediationOutcome` persistence |
| **CON-2** | Console auth (OAuth / basic / SSO proxy) | Pending | BFF currently open on `:8091` |
| **CON-3** | Keyboard shortcuts (approve/reject on focus) | Pending | Power users |
| **CON-4** | Unified activity feed (Telegram + web + HIL) | Pending | Single timeline per resource |
| **CON-5** | “Latest only” default filter on Resources page | Pending | UX polish (partially via “Show attempt history” toggle) |

Details: [OPERATIONS-CONSOLE.md](./OPERATIONS-CONSOLE.md)

---

## Track C — CI / code remediation

| ID | Item | Status | Doc |
|----|------|--------|-----|
| **CI-1** | Dependency/env code PR + HIL | **Done** | Phase 1 |
| **CI-2** | Coding agent worker + orchestrator handoff + console live panel | **Done** | [CI Phase 2](./CI-CODE-REMEDIATION-ROADMAP.md#phase-2--coding-agent-recommended-design) |
| **CI-3** | Post-PR CI verify + notify | Pending | Phase 3 |
| **CI-4** | Custom/composite agent skills templates | Pending | Phase 4 |
| **CI-5** | Proactive webhook + auto-triage expansion | Pending | Phase 5 |
| **CI-6** | Expand classifiers (`go mod`, `cargo`, `pnpm`, Docker `RUN`) | Pending | Backlog |
| **CI-7** | Per-repo allowlist + rate limits for auto-PR | Pending | Backlog |

Also: **UX-10** coding agent persona — narration templates **done**; service = **CI-2** **done**.

Details: [CI-CODE-REMEDIATION-ROADMAP.md](./CI-CODE-REMEDIATION-ROADMAP.md)

---

## Track D — Observability & investigation (Holmes-inspired)

Adopt Holmes **data access patterns** without LLM MCP. Facts flow: **investigator (code) → sanitize → brain (plan)**.

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-4a** | `POST /observability/logs` — Loki + pod log fallback | **Done** | [DEEP-RCA.md](./DEEP-RCA.md) |
| **PLAT-4b** | `POST /observability/metrics` — PromQL workload bundle | **Done** | Wired in `rca-enrich.ts` |
| **PLAT-4c** | Wire observe node + brain `rcaPointers` | **Done** | Progress message in orchestrator |
| **PLAT-9** | Server-side log excerpt limits (`log-excerpt.ts`) | **Partial** | Loki merge + signal line pick |
| **PLAT-10a** | Datadog logs/metrics plugin (optional) | Pending | Later breadth |
| **PLAT-10b** | Grafana Tempo traces plugin (optional) | Pending | Later breadth |

**Env:**

```bash
LOKI_URL=
PROMETHEUS_URL=
```

Do **not** expose these as MCP tools to the LLM. See [LLM-AND-MCP.md](./LLM-AND-MCP.md).

---

## Track E — Proactive detection & alert ingress

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-6a** | Scheduled health check CRD or cron → `POST /runs` | Pending | Holmes operator-style; any datasource after Phase D |
| **PLAT-6b** | Post-deploy verification hook (Helm release → check run) | Pending | Pair with pre-deploy mode |
| **PLAT-7a** | AlertManager webhook → commander → orchestrator | Pending | Holmes alert ingress pattern |
| **PLAT-7b** | PagerDuty / OpsGenie webhook (optional) | Pending | Lower priority |
| **WATCH-1** | Watcher: configurable `COOLDOWN_MINUTES`, ignore list sync | **Done** | Compose default 2 min |

Holmes comparison: [HOLMES-COMPARISON-AND-ADOPTION.md](./HOLMES-COMPARISON-AND-ADOPTION.md)

---

## Track F — Skills & learning loop

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-8a** | Manual skill export from console | **Done** | Copy snippet / Export skills |
| **PLAT-8b** | Auto-write `skills/*.md` on `worked: true` outcomes | Pending | Filesystem or git commit bot |
| **PLAT-8c** | Brain prompt injection ranking — prefer skills matching resource/mode | Pending | After 8b |
| **SKILL-1** | `CICD_SKILLS_DIR` team runbooks | **Done** | Manual `*.md` in `skills/` |

---

## Track G — Conversational UX

| ID | Item | Status | Doc |
|----|------|--------|-----|
| UX-1–UX-9 | Narration, buttons, LLM routing, disclosure, sessions, CI classify, outcomes, streaming, prefs | **Done** | [CONVERSATIONAL-UX-ROADMAP.md](./CONVERSATIONAL-UX-ROADMAP.md) |
| UX-10 | Coding agent persona templates | **Done** (templates) | Service = CI-2 |
| UX-11 | LLM startup self-test | **Done** | `llm-probe.ts`, `/health` shows `commanderLlmProbe` |
| UX-12 | Built-in help intent | **Done** | `help.ts`, LLM `help` intent |
| UX-13 | Chat transcript memory | **Done** | `chat-transcript.ts`, LLM context |
| UX-14 | Active topic session | **Done** | `active-topic.ts` |
| UX-15 | Clarification loop | **Done** | `clarification.ts` |
| UX-16 | Console chat panel | **Done** | `/chat`, Operations Console **Assistant** |
| UX-17 | LLM workload-status intent | **Done** | `workload-status` in unified router |

---

## Track H — Security & enterprise (optional)

| ID | Item | Status |
|----|------|--------|
| **PLAT-11** | Read-only debug MCP sidecar for investigator only (human-triggered) | Pending |
| **PLAT-12** | External RCA handoff — schema + merge API | **Design** | [RCA-HANDOFF-SCHEMA.md](./RCA-HANDOFF-SCHEMA.md) |
| **PLAT-14** | Platform layers — packages + RCA plugin SDK | **Design** | [PLATFORM-LAYERS.md](./PLATFORM-LAYERS.md) |
| **ENT-1** | SIEM export for remediation outcomes | Pending |
| **ENT-2** | Per-namespace autonomy policy in console | Pending |

---

## What we are not doing

| Item | Reason |
|------|--------|
| Replace sre-bot with HolmesGPT | Loses remediation loop, HIL, GitOps path |
| LLM kubernetes-remediation MCP | LLM-initiated writes bypass security model |
| Open agentic loop in orchestrator | Cost, non-determinism, audit gaps |
| Auto-merge CI PRs without HIL | Enterprise safety |

---

## Status summary

| Area | Shipped | Next up |
|------|---------|---------|
| Conversational UX | UX-1–17 (UX-10 templates only; CI-2 for coding agent service) | — |
| Operations Console | Grouped resources, outcomes, export | CON-2 auth |
| CI remediation | Phase 1 | Phase 2 coding agent |
| Observability | K8s facts + **deep RCA** | PLAT-10 Datadog/Tempo |
| Proactive | Watcher + ignore | PLAT-6 operator, PLAT-7 alerts |
| Platform hygiene | PLAT-1 NL fix, PLAT-2 dedupe, PLAT-3 watcher keys, outcome persistence | PLAT-13 active run index |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-02 | PLAT-2 done: orchestrator run dedupe on active `running`/`awaiting_human` runs |
| 2026-06-02 | PLAT-3 done: watcher cooldown key normalized from pod names to workload names |
| 2026-05-29 | Initial consolidated roadmap; Holmes adoption items; PLAT/CON/CI tracks |
| 2026-05-29 | PLAT-1 marked done (Gemini commander model); CON-1 done (grouped resources) |
