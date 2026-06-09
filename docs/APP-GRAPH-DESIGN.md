# Application Graph & App Review — Design

## Problem

Pod-level investigation answers “why is this Deployment crashing?” but not “why isn’t **my app** working?” — the question operators ask when traffic fails end-to-end across Deployments, Services, Ingress, and dependencies.

This feature adds a **deterministic application graph** (no LLM graph construction) and an **app review** pass that finds the **frontier failure**: the first unhealthy node on the path from entry (Ingress / front Service) to the failing leaf.

## Goals (P0–P4)

| Phase | Deliverable |
|-------|-------------|
| P0 | Shared schema + review algorithm (`shared/src/app-graph.ts`) |
| P1 | Investigator builds graph from K8s API + `GET /app-graph`, `GET /app-review` |
| P2 | Commander parses app investigate intent; sync chat reply via app review |
| P3 | Orchestrator `gatherFactsSync` maps app review → `DiagnosisContext` |
| P4 | Console `AppGraphPanel` on Overview + BFF proxy |

**Out of scope (P5 / PLAT-4):** OTel/Hubble-observed runtime edges.

## Architecture

```
User: "why isn't checkout working?"
        │
        ▼
   Commander (parser → scope=app)
        │
        ├─ sync: GET investigator /app-review → compose chat reply
        │
        └─ async (remediation): orchestrator gatherFactsSync(scope=app)
                │
                ▼
           Investigator app-graph-builder
                │
                ▼
           shared app-graph.reviewAppGraph()
                │
                ├─ frontier node + narrative → DiagnosisContext
                └─ console GET /api/app-review → AppGraphPanel
```

Remediation loop (HIL → gitops → verify) is unchanged; app review only improves **observe** context.

## Graph schema

### Nodes (`AppNode`)

| Field | Description |
|-------|-------------|
| `id` | Stable id, e.g. `deploy:sre-bot-system/commander` |
| `kind` | `deployment` \| `service` \| `ingress` \| `pod` \| `external` |
| `namespace` | K8s namespace (empty for external) |
| `name` | Resource name |
| `status` | `ok` \| `degraded` \| `down` \| `unknown` |
| `detail` | Human-readable status line |
| `ready` / `desired` | Replica counts where applicable |

### Edges (`AppEdge`)

| Field | Description |
|-------|-------------|
| `from` / `to` | Node ids |
| `kind` | `selects` \| `routes` \| `depends-on` \| `annotated` \| `env-ref` |

Edge sources (deterministic, in build order):

1. **Deployment → Service** — label selector overlap or name match
2. **Service → Ingress** — ingress backend serviceName
3. **Deployment → Pod** — pod owner / selector
4. **Deployment → external** — env vars (`*_HOST`, `*_URL`, `DATABASE_URL`, etc.)
5. **Annotations** — `sre.bot/depends-on` (comma-separated service or host names)

### Annotations (optional, recommended)

```yaml
metadata:
  annotations:
    sre.bot/app-id: checkout          # groups resources into one logical app
    sre.bot/depends-on: postgres,redis.sre-bot-system.svc
```

When `app-id` is set on a Deployment, listing apps uses that id. Without annotations, the **deployment name** (or user hint) is the app id within a namespace.

## App review algorithm

1. Mark entry nodes: Ingress nodes, or Deployments with no incoming `routes` edge.
2. BFS from entry nodes following edge direction.
3. Collect nodes with `status !== 'ok'`.
4. **Frontier** = unhealthy node with minimum BFS depth (closest to entry).
5. Build narrative: entry → … → frontier with status at each hop.

Status derivation (K8s-only):

| Resource | `down` | `degraded` | `ok` |
|----------|--------|------------|------|
| Deployment | desired > 0, ready = 0 | ready < desired | ready = desired |
| Pod | Failed / CrashLoopBackOff | Pending / not ready | Running + ready |
| Service | no endpoints (cluster IP) | — | has ready endpoints |
| Ingress | no load-balancer / no backends | partial backends | backends ready |
| External | — | — | `unknown` (no probe in P0–P4) |

## API contracts

### Investigator

```
GET /app-graph?appId=checkout&namespace=default&force=false
GET /app-review?appId=checkout&namespace=default&force=false
```

Response (`AppReviewResult`):

```json
{
  "appId": "checkout",
  "namespace": "default",
  "checkedAt": "2026-06-05T…",
  "reachable": true,
  "overallStatus": "degraded",
  "frontierNodeId": "deploy:default/checkout-api",
  "narrative": "Ingress checkout → Service checkout-api (ok) → Deployment checkout-api (0/3 ready) …",
  "graph": { "nodes": [], "edges": [] },
  "clusterReachable": true
}
```

### Console BFF

```
GET /api/app-review?appId=&namespace=
GET /api/app-graph?appId=&namespace=
```

## Commander intent

New `InvestigateScope`: `'app'`.

Trigger phrases:

- `why isn't (my|the) app X working`
- `why isn't X working` (when followed by “app” or “application”)
- `investigate app X`
- `app review (for) X`

Sync path (like cluster health): fetch `/app-review`, compose `app_review` outcome.

Async path: `StartRunRequest.investigateScope = 'app'` for remediation follow-ups.

## Orchestrator observe

When `investigateScope === 'app'`, `gatherFactsSync` calls app review and maps:

- `resourceName` = app id
- `primaryFailure` / logs = frontier detail + narrative
- `recentEvents` from frontier deployment pods

## Console UI

`AppGraphPanel` on Overview:

- App id input + namespace (optional)
- Traffic-light nodes (ok / degraded / down)
- Frontier highlight + narrative
- Link: “Investigate in chat” → `/chat?q=investigate app …`

## Testing

- `shared/test/app-graph.test.ts` — frontier detection, narrative, status rollup
- Commander parser tests for app phrases (optional follow-up)

## Future (P5)

- Merge OTel service graph edges (`PLAT-4`)
- Hubble L3/L4 observed dependencies (`PLAT-12`)
- LLM narration polish only (never graph construction)
