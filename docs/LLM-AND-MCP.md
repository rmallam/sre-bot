# LLM configuration and MCP (Holmes comparison)

## OpenRouter multi-model (default)

sre-bot uses **two models** via one OpenRouter API key (Holmes-style `modelList`, but fixed roles):

| Role | Service | Env var | Default model |
|------|---------|---------|----------------|
| **Planner** | `brain` | `OPENROUTER_BRAIN_MODEL` | `anthropic/claude-sonnet-4` |
| **Router** | `commander` | `OPENROUTER_COMMANDER_MODEL` | `google/gemini-2.5-flash` |

```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BRAIN_MODEL=anthropic/claude-sonnet-4
OPENROUTER_COMMANDER_MODEL=google/gemini-2.5-flash
```

### Provider modes

| `LLM_PROVIDER` | Behavior |
|----------------|----------|
| `openrouter` (default in Helm) | Requires `OPENROUTER_API_KEY`; falls back to Gemini if key missing |
| `gemini` | Prefer native Google API (`GEMINI_API_KEY`) |
| `auto` | OpenRouter if key set, else Gemini |

Legacy: `OPENROUTER_MODEL` applies to both roles if role-specific vars are unset.

### Verify

```bash
curl -s http://localhost:8083/health | jq .llm
```

### Helm

```yaml
llm:
  provider: openrouter
  openrouter:
    brainModel: anthropic/claude-sonnet-4
    commanderModel: google/gemini-2.5-flash
```

Set `secrets.openrouterApiKey` in your values file.

---

## Should we use Kubernetes MCP (like Holmes)?

**Short answer: no for the core loop; maybe later as an investigator add-on.**

Holmes deploys optional [kubernetes-mcp-server](https://github.com/containers/kubernetes-mcp-server) so the **LLM calls kubectl-style tools** during an open agentic loop.

sre-bot deliberately does **not** give the LLM cluster tools:

| | Holmes K8s MCP | sre-bot |
|--|----------------|---------|
| Who talks to the API? | LLM via MCP | **investigator** (code) |
| Tool choice | Model picks commands each turn | Fixed pipeline in **orchestrator** |
| Writes | Optional remediation MCP | **executor** / **gitops** only, after **security** + **HIL** |
| Audit | MCP + RBAC | Run transcript + authorize-action |

### Why we skip K8s MCP in brain/commander

1. **Security model** — sanitize → plan → authorize assumes the LLM never holds raw API access.
2. **Determinism** — restart / git_patch / helm_deploy are enumerated actions, not arbitrary `kubectl patch`.
3. **Cost/latency** — multi-step MCP loops are expensive; we gather facts once, plan once, act via typed tools.

### What to adopt from Holmes instead

- **More fact sources** — Prometheus, Loki, Datadog as investigator plugins (same pattern as `cluster-facts.ts`), not LLM-driven MCP.
- **Skills / runbooks** — ConfigMap `SKILL.md` injected into brain system prompt.
- **Operator-style checks** — CRD or cron → `POST /runs` (like Holmes operator → Holmes API).

### When K8s MCP might make sense

- A **read-only** MCP sidecar used only by **investigator** for rare resources your fact gatherer does not cover yet — still **not** exposed to the LLM.
- A separate **debug profile** (`LLM_PROVIDER=openrouter` + experimental flag) for human-driven troubleshooting only — not for autonomous act.

Holmes’s **kubernetes-remediation** MCP is the opposite of our design (LLM-initiated writes). Use **executor** + **gitops** + HIL instead.
