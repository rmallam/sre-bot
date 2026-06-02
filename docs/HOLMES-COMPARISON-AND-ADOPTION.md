# HolmesGPT Comparison & Adoption Guide

How [HolmesGPT](https://github.com/HolmesGPT/holmesgpt) (CNCF sandbox SRE agent) relates to **sre-bot**, what to adopt, and what to avoid.

Related: [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md) · [LLM-AND-MCP.md](./LLM-AND-MCP.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Executive summary

| Question | Answer |
|----------|--------|
| Is Holmes “better”? | **Different product bet** — not a drop-in replacement |
| Holmes strength | Multi-source **investigation** (Prom, Loki, Datadog, traces, cloud, DBs) |
| sre-bot strength | **Gated remediation** (GitOps, Helm, CI PRs, HIL, verify loop, audit) |
| Replace sre-bot with Holmes? | **No** — you lose LangGraph remediation, security model, structured CI fix path |
| Replace Holmes with sre-bot? | **No** — you lose breadth of observability integrations (until Phase D ships) |
| Recommended path | **Selective adoption** of Holmes *patterns*, not their MCP write model |

---

## How HolmesGPT works

Holmes is a **Python agentic investigator**. The LLM runs an open loop:

```text
Alert / chat / scheduled check
    → LLM chooses next tool from 40+ “toolsets” (MCP / REST)
    → Fetch Prometheus metrics, Loki logs, K8s describe, GitHub, …
    → LLM reads output, picks next tool
    → Repeat until root cause narrative is ready
    → Slack / Jira / PagerDuty / write-back
```

**Components:**

| Piece | Role |
|-------|------|
| CLI / `server.py` | Interactive Q&A and API |
| **Toolsets** | Built-in integrations (K8s, Prom, Loki, Tempo, AWS, Azure, Datadog, GitHub MCP, …) |
| **MCP** | Many datasources exposed as tools the **LLM calls directly** |
| **Operator mode** | In-cluster 24/7 scheduled health checks + deploy verification |
| **Remediation MCP** (optional) | LLM-initiated K8s scale / rollback / edits |

**Design emphasis:** read-only investigation at **petabyte scale** (streaming, memory limits, server-side filtering). Writes are optional via remediation MCP.

---

## How sre-bot works (contrast)

```text
Watcher / Telegram
    → orchestrator (LangGraph — fixed graph)
    → investigator gathers facts (code, not LLM)
    → security sanitizes + authorizes
    → brain plans ONE structured action
    → HIL if needed
    → executor / gitops / cicd act
    → verify → retry with memory
    → commander narrates outcome
```

**Design emphasis:** LLM **plans only**; cluster/Git writes go through **typed tools** after **security + HIL**.

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [LLM-AND-MCP.md](./LLM-AND-MCP.md).

---

## Feature comparison

| Dimension | HolmesGPT | sre-bot |
|-----------|-----------|---------|
| Primary job | Investigate across observability stacks | Detect → approve → fix → verify |
| LLM + tools | LLM picks tools each turn (MCP) | LLM plans once; tool compiler + graph |
| Cluster writes | Optional remediation MCP | executor / gitops only, after gates |
| Integrations | 40+ toolsets | K8s, GitHub Actions, GitOps, Telegram |
| Proactive | Operator + AlertManager/PagerDuty/Jira | watcher (K8s events + pod poll) |
| CI fixes | General via GitHub/Jenkins MCP | Structured classify → PR + HIL |
| Deploy | Helm toolset (investigate) | Full pre-deploy + dual-repo GitOps |
| Chat UX | Slack (often Robusta), CLI | Telegram PA, narration, session follow-ups |
| UI | CLI + experimental ag-ui | Operations Console |
| Audit | RBAC, read-only default | security-agent, policy, run store, ignore list |
| Community | CNCF, 2.5k+ stars | Opinionated internal platform |

---

## Where Holmes is ahead

1. **Investigation depth** — metrics + logs + traces + DBs in one session.
2. **Integration catalog** — years of toolsets vs our K8s/GitHub focus.
3. **Alert/ticket ingress** — AlertManager, PagerDuty, OpsGenie, Jira native.
4. **Operator at scale** — scheduled checks on any connected datasource.
5. **Large payload handling** — mature patterns for log/metric volume.

**Choose Holmes (or build Phase D)** when the pain is: *“We have Datadog + Loki + Prom and need one agent to dig through all of it.”*

---

## Where sre-bot is ahead

1. **Controlled remediation** — Git patch, GitOps mirror, ArgoCD, restart, verify, circuit breaker.
2. **Security model** — no LLM kubectl; sanitize → authorize → enumerated actions.
3. **CI pipeline** — category → brain patch → HIL → code/workflow PR.
4. **Operations product** — console, grouped resources, remediation outcomes, skill export.
5. **Conversational ops** — NL routing, session-linked runs, dual-channel HIL.

**Choose sre-bot** when the pain is: *“Detect CrashLoop → propose fix → I approve → apply GitOps → verify → ignore if needed.”*

---

## Adoption map (Holmes → sre-bot)

| Holmes pattern | sre-bot implementation | Roadmap |
|----------------|------------------------|---------|
| Prometheus / Loki toolsets | **Investigator plugins** — code fetches facts, brain plans | [DEVOPS Phase D](./DEVOPS-AGENT-PHASES.md#phase-d--observability-loki--prometheus) · **PLAT-4** |
| Skills / runbooks in prompt | `skills/` + console export + auto-sync | **PLAT-8** · [OPERATIONS-CONSOLE](./OPERATIONS-CONSOLE.md) |
| Operator scheduled checks | CRD or cron → `POST /runs` | **PLAT-6** |
| AlertManager / PagerDuty ingress | Webhook → commander → orchestrator | **PLAT-7** |
| Large log handling | Server-side filter in investigator/cicd before LLM | **PLAT-9** |
| Datadog / Tempo / multi-cloud | Additional investigator backends (later) | **PLAT-10** |
| Interactive debug MCP | Read-only debug profile for humans only | **PLAT-11** (optional) |

### Do **not** adopt

| Holmes pattern | Why |
|----------------|-----|
| **kubernetes-remediation MCP** (LLM writes) | Conflicts with security-agent + HIL + typed compiler |
| **LLM-driven kubectl loop** in brain/commander | Violates “LLM plans, tools act” principle |
| **Replace orchestrator with open agent loop** | Loses verify/retry, policy gates, audit transcripts |

---

## Optional hybrid architecture (future)

For teams needing both deep RCA and safe fixes:

```text
Holmes (or investigator Phase D+) ──structured RCA summary──► sre-bot orchestrator
                                                                    ↓
                                                              HIL → gitops/executor
```

Holmes (or enriched investigator) produces **facts + hypothesis**; sre-bot owns **action + verify**. Schema: [RCA-HANDOFF-SCHEMA.md](./RCA-HANDOFF-SCHEMA.md) · integration item **PLAT-12** in [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md).

---

## Decision matrix

| Your priority | Recommendation |
|---------------|----------------|
| Safe autonomous K8s/GitOps fixes | **Stay on sre-bot**; implement PLAT-1–3 |
| Rich observability RCA | **Phase D** (Prom/Loki plugins), not Holmes fork |
| Alert-driven workflows | **PLAT-7** (AlertManager webhook) |
| 24/7 proactive beyond K8s events | **PLAT-6** (operator-style checks) |
| Fastest time-to-investigate everything | Run Holmes **alongside** for ad-hoc only; sre-bot for remediation |
| Single unified product | Invest in Phase D + PLAT-6/7; do not replatform on Holmes |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-05-29 | Initial comparison and adoption map |
