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
- [AGENT-MODE-DESIGN.md](./AGENT-MODE-DESIGN.md)

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
| 5 | **AGENT-1–2** | Case model + commander case bind | Follow-up continuity |
| 6 | **PLAT-4** | Observability investigator plugins (Prom / Loki) | Holmes-style RCA |
| 7 | **CON-2** | Console auth (SSO or basic) | Production console — **deferred (POC)** |
| 8 | **AGENT-3–5** | Investigator tool loop + ReAct graph + `SRE_AGENT_MODE` | Full LLM-driven flow (opt-in) |
| 9 | **CI-3** | Post-PR CI verify + notify | Close CI remediation loop |
| 10 | **PLAT-8** | Auto-sync skills + ranked brain injection | Learning loop |
| 11 | **PLAT-6** | Operator-style scheduled health checks | Proactive beyond K8s events |
| 12 | **PLAT-7** | Alert ingress (AlertManager → commander) | Alert-driven runs |
| 13 | **PLAT-9** | Large log/metric payload filtering | Scale investigator/cicd |
| 14 | **PLAT-10** | Additional backends (Datadog, Tempo) | Optional breadth |
| 15 | **PLAT-11** | Read-only debug MCP profile (human-only) | Optional power-user |
| 16 | **PLAT-12** | Hybrid RCA handoff (external summary → orchestrator) | [Design ready](./RCA-HANDOFF-SCHEMA.md) |
| 17 | **DEPLOY-2** | Source-to-image / buildpack deploy pipeline | [Phase 2 shipped](./SOURCE-TO-IMAGE-DEPLOY.md) |

---

## Track A — Platform reliability & noise reduction

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-1** | **Natural language routing** — `GEMINI_COMMANDER_MODEL=gemini-2.5-flash` | **Done** | |
| **PLAT-2** | **Run deduplication** | **Done** | |
| **PLAT-3** | **Watcher cooldown normalization** | **Done** | |
| **PLAT-13** | **Orchestrator “active run” index** — Redis/Postgres lookup by resource key | **Done** | Postgres `resource_key` index |
| **PLAT-14** | Stale HIL run reconcile | **Done** | Orphan `awaiting_human` auto-cancel |
| **PLAT-15** | Smart rollout wait (pod phase–aware verify) | **Done** | Post-remediation, not blind timers |

---

## Track B — Operations Console

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **CON-1** | Grouped resources + remediation outcomes + skill export | **Done** | |
| **CON-2** | Console auth (OAuth / basic / SSO proxy) | **Deferred** | POC — open `:8091` acceptable for now |
| **CON-3** | Keyboard shortcuts (approve/reject on focus) | **Done** | A/R/I + J/K on Approvals |
| **CON-4** | Unified activity feed (Telegram + web + HIL) | **Done** | `/activity` timeline |
| **CON-5** | “Latest only” default filter on Resources page | **Done** | Runs page default |

Details: [OPERATIONS-CONSOLE.md](./OPERATIONS-CONSOLE.md)

---

## Track C — CI / code remediation

| ID | Item | Status | Doc |
|----|------|--------|-----|
| **CI-1** | Dependency/env code PR + HIL | **Done** | Phase 1 |
| **CI-2** | Coding agent worker + orchestrator handoff + console live panel | **Done** | Phase 2 |
| **CI-3** | Post-PR CI verify + notify | **Done** | Polls GitHub Actions on PR branch; notifies ✅/❌ |
| **CI-4** | Custom/composite agent skills templates | Pending | Phase 4 |
| **CI-5** | Proactive webhook + auto-triage expansion | Pending | Phase 5 |
| **CI-6** | Expand classifiers (`go mod`, `cargo`, `pnpm`, Docker `RUN`) | Pending | Backlog |
| **CI-7** | Per-repo allowlist + rate limits for auto-PR | Pending | Backlog |

**CI-3 env:** `CI_VERIFY_AFTER_PR`, `CI_VERIFY_INITIAL_DELAY_MS`, `CI_VERIFY_POLL_MS`, `CI_VERIFY_TIMEOUT_MS`

Details: [CI-CODE-REMEDIATION-ROADMAP.md](./CI-CODE-REMEDIATION-ROADMAP.md)

---

## Track D — Observability & investigation

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-4a–c** | Loki + PromQL + observe wiring | **Done** | |
| **PLAT-9** | Server-side log excerpt limits | **Partial** | |
| **PLAT-10a/b** | Datadog / Tempo plugins | Pending | |

---

## Track E — Proactive detection & alert ingress

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-6a/b** | Scheduled health checks + post-deploy hook | Pending | |
| **PLAT-7a/b** | AlertManager / PagerDuty webhooks | Pending | |
| **WATCH-1** | Watcher cooldown + ignore list | **Done** | |

---

## Track F — Skills & learning loop

| ID | Item | Status | Notes |
|----|------|--------|-------|
| **PLAT-8a** | Manual skill export from console | **Done** | Copy markdown for manual `/rag/learn` |
| **PLAT-8b** | Auto-learn runbooks on `worked: true` | **Done** | pgvector via `SRE_RAG_LEARNING` (no filesystem) |
| **PLAT-8c** | Brain ranked runbook injection | **Done** | `POST /rag/query` by mode/resource/repo/error |
| **PLAT-8d** | Platform RAG learn on verified outcomes | **Done** | `sre_runbooks` upsert |
| **SKILL-1** | Team runbooks in vector store | **Done** | Bootstrap script + learn loop |

---

## Track G — Conversational UX

| ID | Item | Status |
|----|------|--------|
| UX-1–UX-17 | Narration, buttons, LLM routing, streaming, console chat, etc. | **Done** |

---

## Track I — Agent modes (classic vs LLM-driven)

| ID | Item | Status |
|----|------|--------|
| **AGENT-1–7** | Case model, tool loop, ReAct graph, progress, LLM routing | **Done** |
| **AGENT-8** | Per-channel / per-run mode override | Partial |
| **AGENT-D1–D3** | Skill inject, evidence cache, case dedup | Partial — D1 via PLAT-8c; D2/D3 pending |

Enable agentic: `SRE_AGENT_MODE=agentic` — see [AGENT-MODE-DESIGN.md](./AGENT-MODE-DESIGN.md)

---

## Track H — Security & enterprise (optional)

| ID | Item | Status |
|----|------|--------|
| **PLAT-11** | Read-only debug MCP sidecar | Pending |
| **PLAT-12** | External RCA handoff schema + merge API | **Design** |
| **PLAT-14** | Platform layers / package extraction | **Design** |
| **ENT-1/2** | SIEM export, per-namespace autonomy in console | Pending |

---

## What we are not doing (POC phase)

| Item | Reason |
|------|--------|
| **CON-2 Console auth** | Deferred until production exposure |
| Replace sre-bot with HolmesGPT | Loses remediation loop, HIL, GitOps |
| LLM kubernetes-remediation MCP | Bypasses security model |
| Auto-merge CI PRs without HIL | Enterprise safety |

---

## Status summary (2026-06-05)

| Area | Shipped | Next up |
|------|---------|---------|
| Conversational UX | UX-1–17 | — |
| Operations Console | Grouped resources, outcomes, export, activity feed | CON-2 auth deferred |
| CI remediation | Phases 1–3 (incl. post-PR verify) | CI-4 custom agent templates |
| Cluster investigate | Agentic mode, smart rollout wait, git-patch gates | AGENT-D2/D3 |
| Observability | K8s facts + deep RCA | PLAT-10 Datadog/Tempo |
| Learning loop | RAG learn + ranked `/rag/query` injection | — |
| Proactive | Watcher + ignore | PLAT-6 operator, PLAT-7 alerts |
| Platform | Dedupe, stale HIL reconcile, active run index, sre-agent-platform sidecar | PLAT-6/7 proactive |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-05 | **CI-3** done: post-PR CI verify watch + notify; **PLAT-8b/c/d** learning loop complete |
| 2026-06-05 | **AGENT-1–7**, smart rollout wait, git-patch preflight, platform sidecar shipped |
| 2026-06-02 | PLAT-2/3 done: run dedupe + watcher cooldown normalization |
| 2026-05-29 | Initial consolidated roadmap |
