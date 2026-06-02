# Platform Layers — Reusable Codebase Design

How to stop growing agent folders and build **shared, composable packages** that agents thinly wire together.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) · [DEEP-RCA.md](./DEEP-RCA.md) · [RCA-HANDOFF-SCHEMA.md](./RCA-HANDOFF-SCHEMA.md) · [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md)

**Status:** Design — incremental migration, no big-bang replatform.

---

## Problem today

| Symptom | Example |
|---------|---------|
| Logic lands in agent `src/` | `investigator/rca-enrich.ts`, `commander/router.ts` health path |
| Duplicated infra | `buildKubeConfig()` in **8+ files** (investigator, watcher, executor, brain, gitops) |
| Flat `shared/` | 43 files, no domain boundaries — everything imports everything |
| New datasource = edit investigator | Datadog/Tempo means more agent code, not a plugin |
| Relative imports | `../../../shared/src/types.js` across 80+ agent files |

Agents should be **HTTP adapters + wiring**. Domain logic should live in **reusable packages**.

---

## Target model

```text
packages/                    ← reusable libraries (npm workspaces)
  core/                      types, http, policy, llm-config, audit
  k8s/                       kube client, facts, resolve, verify
  observability/             Loki, Prom, plugin SDK, log-excerpt, rca-pointers
  remediation/               plan types, validation, suggest-fix, outcomes
  conversation/              parser, intent, run-update, health-report, narrate helpers
  ci/                        ci-diagnose, github, workflow patch
  gitops/                    helm, patch, argo, repo mirror
  integrations/              optional: holmes-handoff adapter, alertmanager ingress

agents/                      ← thin services (Express + env + route handlers)
  investigator/              mounts k8s + observability plugins, exposes /facts
  commander/                   mounts conversation + dispatches runs
  orchestrator/                LangGraph + tool compiler only
  brain/                       LLM prompts + plan validation only
  …

plugins/                     ← team-owned extensions (optional)
  datadog/
  tempo/
  acme-internal-runbook/
```

**Rule:** If it does not need its own port/process, it belongs in `packages/`, not `agents/`.

---

## Package responsibilities

### `@sre-bot/core`

Already mostly in `shared/` — consolidate:

- `types.ts`, `http.ts`, `policy.ts`, `tool-contracts.ts`, `tool-registry.ts`
- `llm-config.ts`, `openrouter.ts`
- `audit-siem.ts`, `user-errors.ts`

**Agents import:** config, logging, types only.

### `@sre-bot/k8s`

Extract from investigator, watcher, executor, gitops, brain:

- `buildKubeConfig()` — **one** implementation
- `gatherPodFacts`, `gatherClusterHealthFacts`, `gatherNamespaceHealthFacts`
- `resolveDeploymentByHint`, `resolvePodForWorkload`
- `verifyDeployment`, `restartDeployment`

**Agents:** investigator calls gatherers; executor calls restart; no duplicate kube setup.

### `@sre-bot/observability`

Extract from `shared/observability-query.ts`, `log-excerpt.ts`, `rca-pointers.ts`, `investigator/rca-enrich.ts`:

- **Plugin SDK** (see below)
- Built-in plugins: `loki`, `prometheus`, `kubernetes-events`
- `enrichWithDeepRca()` — orchestrates plugins in parallel

**Agents:** investigator = `createInvestigatorApp({ plugins: [...] })`.

### `@sre-bot/conversation`

Extract from commander:

- `parser.ts`, `intent-mapper.ts`, `command-intent.ts`
- `run-update.ts`, `run-summary.ts`, `health-report.ts`
- Channel-agnostic dispatch interfaces (`CommandHandler`, `NotifyChannel`)

**Agents:** commander implements Telegram/Slack adapters only.

### `@sre-bot/remediation`

- `RemediationPlan` validation, `suggest-fix-parse.ts`, `failure-plan-merge.ts`
- `remediation-outcome.ts`, `post-deploy-recovery.ts`
- Handoff merge (`rca-handoff.ts` when implemented)

**Agents:** brain + orchestrator import; no duplicate plan logic.

### `@sre-bot/ci` / `@sre-bot/gitops`

Move CI and GitOps domains out of `cicd-agent` and `gitops-agent` src into packages; agents expose HTTP routes that delegate.

---

## RCA plugin SDK (highest leverage)

Stop adding one-off files per datasource. Standard interface:

```typescript
/** packages/observability/src/plugin.ts */
export interface RcaPlugin {
  id: string;
  source: RcaPointerSource;
  /** When false, skip without error (e.g. LOKI_URL unset) */
  isConfigured(): boolean;
  /** Parallel-safe gather */
  gather(ctx: RcaGatherContext): Promise<RcaPluginResult | null>;
}

export interface RcaGatherContext {
  incidentId: string;
  namespace: string;
  resourceName: string;
  podName: string;
  scope: 'cluster' | 'namespace' | 'workload';
  mode: IncidentMode;
}

export interface RcaPluginResult {
  pointer: RcaPointer;
  supplementalLogLines?: string[];
}
```

**Built-in registry:**

```typescript
export function createDefaultRcaRegistry(env: NodeJS.ProcessEnv): RcaPlugin[] {
  return [
    new KubernetesSnapshotPlugin(),
    new EventsPlugin(),
    new WorkloadSpecialistPlugin(),
    new LokiPlugin(env),
    new PrometheusPlugin(env),
    // optional: load from plugins/ via dynamic import
  ];
}

export async function gatherAllPointers(
  ctx: RcaGatherContext,
  plugins: RcaPlugin[]
): Promise<DeepRcaResult> {
  const settled = await Promise.allSettled(
    plugins.filter((p) => p.isConfigured()).map((p) => p.gather(ctx))
  );
  // merge → rcaPointers, observabilitySummary, enriched logs
}
```

**Adding Datadog:** new folder `plugins/datadog/index.ts` implements `RcaPlugin` — **zero** investigator agent edits.

**YAML manifest (optional, Holmes-style velocity):**

```yaml
# plugins/acme-cost-spike/plugin.yaml
id: acme-cost-spike
source: prometheus
queryId: deployment_cpu_anomaly   # maps to allowlisted query in observability package
params:
  namespace: "{{ namespace }}"
  deployment: "{{ resourceName }}"
```

Loader validates `queryId` against allowlist — not raw PromQL from disk.

---

## Agent = thin shell

Example target `agents/investigator/src/index.ts`:

```typescript
import { createServiceApp } from '@sre-bot/core/server';
import { createFactsRouter } from '@sre-bot/k8s/facts-routes';
import { createObservabilityRouter } from '@sre-bot/observability/routes';
import { createDefaultRcaRegistry } from '@sre-bot/observability/registry';
import { loadPluginsFromDir } from '@sre-bot/observability/plugin-loader';

const plugins = [
  ...createDefaultRcaRegistry(process.env),
  ...await loadPluginsFromDir(process.env['RCA_PLUGINS_DIR']),
];

const app = createServiceApp({ name: 'investigator-agent' });
app.use(createFactsRouter({ plugins }));
app.use(createObservabilityRouter({ plugins }));
app.listen(8080);
```

Commander cluster health sync path moves to:

```typescript
// packages/conversation/src/handlers/health-investigate.ts
export async function handleHealthInvestigate(cmd: InvestigateCmd, deps: Deps): Promise<string> {
  const facts = await deps.investigator.fetchFacts({ ... });
  return formatHealthInvestigationReport(facts, labelFor(cmd));
}
```

`router.ts` becomes ~30 lines of wiring.

---

## Handoff schema fits here

[RCA-HANDOFF-SCHEMA.md](./RCA-HANDOFF-SCHEMA.md) lives in `@sre-bot/remediation`:

- `RcaHandoffPayload` types
- `mergeRcaPointers()`
- `formatHandoffForBrain()`

Holmes adapter = `@sre-bot/integrations/holmes` — optional package, not core.

---

## Monorepo tooling

```json
// package.json (root)
{
  "private": true,
  "workspaces": ["packages/*", "agents/*", "plugins/*"]
}
```

| Package | Depends on |
|---------|------------|
| `core` | — |
| `k8s` | `core` |
| `observability` | `core`, `k8s` (for pod context) |
| `conversation` | `core`, `remediation` |
| `remediation` | `core`, `observability` |
| `ci` | `core` |
| `gitops` | `core`, `k8s` |
| agents | relevant packages |

**Build:** `tsc -b` project references, or `tsx` + path aliases during migration.

**Docker:** multi-stage build copies `packages/` + one agent; `AGENT_DIR` unchanged.

---

## Migration phases (no big bang)

| Phase | Work | Risk |
|-------|------|------|
| **P0** | Extract `@sre-bot/k8s` — single `buildKubeConfig`, delete 7 duplicates | Low |
| **P1** | Extract `@sre-bot/observability` + plugin interface; refactor `rca-enrich.ts` | Low |
| **P2** | Extract `@sre-bot/conversation` — parser, health handler, run-update | Medium |
| **P3** | npm workspaces + `@sre-bot/core` from flat `shared/` | Medium |
| **P4** | `plugins/` dir + `RCA_PLUGINS_DIR` loader | Low |
| **P5** | CI/GitOps packages; shrink agent folders | Medium |

Each phase shippable independently. Agents keep same HTTP ports and routes.

---

## What stays in agents (on purpose)

| Keep in agent | Why |
|---------------|-----|
| Express route mounting | Process boundary |
| LangGraph graph definition | Orchestrator-specific state machine |
| LLM system prompts (`brain/gemini.ts`) | Role-specific, changes often |
| Telegram/Slack SDK wiring | Channel SDK deps isolated |
| Env-specific boot (`llm-probe`, health) | Deployment concern |

---

## What not to do

| Anti-pattern | Why |
|--------------|-----|
| One giant `shared/` forever | Becomes unmaintainable (current trajectory) |
| LLM plugin loader | Plugins = code gather only |
| Abstract everything day one | Migrate by domain when touching code |
| MCP in core loop | Keep PLAT-11 optional; packages stay code-first |

---

## Quick wins (this week)

Without full monorepo:

1. **`shared/src/kube-config.ts`** — dedupe `buildKubeConfig` (1 PR)
2. **`shared/src/rca/registry.ts`** — plugin interface + move `rca-enrich` logic
3. **`shared/src/conversation/health-investigate.ts`** — move from commander router
4. **Roadmap item PLAT-14** — track package extraction

---

## Success metrics

- New observability source = **1 plugin file**, not 3 agent edits
- Agent `src/` files **< 500 lines** each (wiring only)
- Zero duplicated kube client setup
- Console + commander + orchestrator import same formatters from packages
- Team runbooks in `plugins/` without forking core

---

## Changelog

| Date | Change |
|------|--------|
| 2026-05-29 | Initial platform layers design |
