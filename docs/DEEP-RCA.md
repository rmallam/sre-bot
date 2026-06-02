# Deep RCA Stack

Holmes-style **multi-source root cause analysis** without giving the LLM direct observability tools. The **investigator** gathers evidence in parallel; the **brain** receives structured `rcaPointers` and plans from that.

Related: [HOLMES-COMPARISON-AND-ADOPTION.md](./HOLMES-COMPARISON-AND-ADOPTION.md) · [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md) (PLAT-4)

## Flow

```text
orchestrator observe
    → GET investigator /facts
        → K8s pod facts + events + gitops manifest
        → workload / network / database specialists
        → Loki logs (if LOKI_URL)
        → Prometheus metrics (if PROMETHEUS_URL)
        → merge → rcaPointers[] + observabilitySummary
    → security sanitize
    → brain /plan-only (sees pointers + logs)
```

Unlike Holmes, the LLM does **not** choose PromQL or LogQL queries at runtime. Investigator code runs fixed, reviewable queries and passes summaries upstream.

## RCA pointer sources

| Source | When | What |
|--------|------|------|
| `kubernetes` | Always (workload scope) | Pod spec, container status, kube logs |
| `events` | Warning events present | Recent K8s Warning reasons/messages |
| `workload` / `network` / `database` | Always | Heuristic specialists on logs + events |
| `loki` | `LOKI_URL` set | Pod/deployment log stream (signal lines) |
| `prometheus` | `PROMETHEUS_URL` set | Replicas, restarts, unavailable counts |

Each pointer includes: `title`, `summary`, `findings[]`, `confidence`, optional `excerpt`.

## Configuration

```bash
# Optional — enrich beyond kube API logs
LOKI_URL=http://loki:3100
PROMETHEUS_URL=http://prometheus:9090

# Toggle deep enrichment (default true)
DEEP_RCA_ENABLED=true

# Log line budget for Loki merge
LOKI_MAX_LINES=120
```

Without Loki/Prometheus, deep RCA still runs K8s specialists + events + merges kube logs only.

## Prometheus expectations

Queries use **kube-state-metrics** style series:

- `kube_deployment_status_replicas_available`
- `kube_deployment_status_replicas_unavailable`
- `kube_pod_container_status_restarts_total`

If your cluster uses different metric names, extend `shared/src/observability-query.ts`.

## Loki query shape

- Pod: `{namespace="ns", pod="pod-name"}`
- Deployment fallback: `{namespace="ns", app="deployment-name"}`

## Brain prompt

`brain` includes `rcaPointers`, `observabilitySummary`, and `specialistDiagnostics` in the plan-only JSON payload so root cause reasoning can cross-reference metrics, logs, and events.

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /facts` | Full `DiagnosisContext` including `rcaPointers` |
| `POST /observability/logs` | Direct Loki/kube log query |
| `POST /observability/metrics` | Direct Prometheus query |

Orchestrator tool compiler also exposes `investigator.logs_query` and `investigator.metrics_query` for compiled plans.

## Roadmap (next)

- Cluster/namespace scope RCA pointers (**PLAT-4c**)
- Datadog / Tempo plugins (**PLAT-10**)
- Error-line prioritization tuning from run outcomes → skills

## Changelog

| Date | Change |
|------|--------|
| 2026-05-29 | Initial deep RCA: rca-enrich, Loki/Prom plugins, brain integration |
