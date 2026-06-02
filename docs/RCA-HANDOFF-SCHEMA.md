# RCA Handoff Schema (PLAT-12)

Structured contract for passing **investigation results** into sre-bot without giving the LLM cluster tools. Supports Holmes-style external investigators, bounded agentic follow-up, and **report-only** health queries.

Related: [HOLMES-COMPARISON-AND-ADOPTION.md](./HOLMES-COMPARISON-AND-ADOPTION.md) · [DEEP-RCA.md](./DEEP-RCA.md) · [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md) (PLAT-12)

**Status:** Design only — not wired in orchestrator yet.

---

## Purpose

Today facts flow:

```text
investigator (code) → sanitize → brain /plan-only → act
```

Handoff adds an optional ingress:

```text
External investigator (Holmes, agentic pass-2, manual runbook)
    → RcaHandoffPayload (this schema)
        → orchestrator (merge into DiagnosisContext)
            → brain plans OR report-only reply
            → security → HIL → act → verify
```

The LLM **never** receives raw tool access. It receives **structured pointers** — same as `rcaPointers[]` from deep RCA.

---

## Design principles

1. **Evidence in, plan out** — handoff carries facts and hypotheses, not executable commands.
2. **Compatible with `RcaPointer`** — reuse `shared/src/rca-pointers.ts` types.
3. **Idempotent merge** — orchestrator merges handoff over code-gathered facts; code gather always runs unless `skipCodeGather: true`.
4. **Report-only mode** — `intent: "report"` skips act/HIL; commander returns summary to Telegram/Slack.
5. **Versioned** — `schemaVersion` field for forward compatibility.

---

## Core types (proposed)

```typescript
/** PLAT-12 — external RCA → orchestrator */
export interface RcaHandoffPayload {
  schemaVersion: '1.0';

  /** Who produced this handoff */
  source: RcaHandoffSource;
  incidentId: string;
  receivedAt: string; // ISO

  /** What the user asked for */
  intent: 'remediate' | 'report' | 'investigate_only';

  /** Target scope (matches StartRunRequest) */
  scope: {
    investigateScope: 'cluster' | 'namespace' | 'workload';
    namespace: string;
    resourceKind: ResourceKind;
    resourceName: string;
    podName?: string;
  };

  /** Primary output — same shape as deep RCA */
  rcaPointers: RcaPointer[];

  /** Optional one-paragraph summary for brain / chat */
  observabilitySummary?: string;

  /** Structured hypothesis list (bounded agentic pass-2) */
  hypotheses?: RcaHypothesis[];

  /** Follow-up queries investigator should run (code executes, not LLM) */
  followUpQueries?: RcaFollowUpQuery[];

  /** Overall confidence 0–1 */
  confidence?: number;

  /** Free-text for humans; not shown to brain unless sanitized */
  operatorNotes?: string;

  /** Suggested action — brain may override after review */
  suggestedPlan?: Partial<RemediationPlan>;

  /** Provenance for audit */
  provenance?: {
    toolTrace?: RcaToolTraceEntry[];
    model?: string;
    turnCount?: number;
    durationMs?: number;
  };
}

export type RcaHandoffSource =
  | 'holmes'
  | 'investigator_agentic'
  | 'investigator_code'
  | 'manual'
  | 'external_api';

export interface RcaHypothesis {
  id: string;
  statement: string;
  confidence: number;
  supportingPointerSources: RcaPointerSource[];
  ruledOut?: boolean;
}

export interface RcaFollowUpQuery {
  id: string;
  backend: 'loki' | 'prometheus' | 'kubernetes' | 'tempo' | 'datadog';
  /** Pre-approved query template id — NOT raw PromQL from LLM */
  queryId: string;
  params: Record<string, string>;
  reason: string;
}

export interface RcaToolTraceEntry {
  at: string;
  tool: string;
  success: boolean;
  summary?: string;
  durationMs?: number;
}
```

---

## API surfaces (proposed)

### 1. Start run with handoff

```http
POST /runs
Content-Type: application/json

{
  "incidentId": "...",
  "mode": "diagnose",
  "namespace": "_all",
  "resourceName": "_cluster",
  "investigateScope": "cluster",
  "platform": "telegram",
  "channelId": "12345",
  "rcaHandoff": { ... RcaHandoffPayload ... }
}
```

Orchestrator behavior:

| `intent` | Graph path |
|----------|------------|
| `report` | observe (optional skip) → merge handoff → format report → notify → END |
| `investigate_only` | observe → merge → brain plan → noop/escalate → notify with RCA |
| `remediate` | observe → merge → brain plan → normal act/HIL/verify |

### 2. Mid-run handoff (bounded pass-2)

```http
POST /runs/:runId/rca-handoff
Content-Type: application/json

{ "followUpQueries": [...], "rcaPointers": [...] }
```

Used after brain returns `hypotheses[]` — investigator executes `followUpQueries` from allowlist, returns updated pointers, brain plans once.

### 3. External Holmes bridge (optional)

```http
POST /integrations/holmes/rca
Authorization: Bearer ...

{ "holmesSessionId": "...", "summary": "...", "rawToolTrace": [...] }
```

Adapter maps Holmes output → `RcaHandoffPayload` with `source: "holmes"`.

---

## Merge rules (orchestrator)

When `rcaHandoff` is present on `StartRunRequest`:

1. Run code gather (`GET /facts`) unless `skipCodeGather: true`.
2. Merge pointers: `dedupeBy(source + title)`, prefer **higher confidence**.
3. Set `DiagnosisContext.rcaPointers` and `observabilitySummary`.
4. Attach `metadata.rcaHandoff` on run store for audit.
5. Brain prompt unchanged — already reads `rcaPointers`.

```typescript
function mergeRcaPointers(
  code: RcaPointer[],
  handoff: RcaPointer[]
): RcaPointer[] {
  const key = (p: RcaPointer) => `${p.source}:${p.title}`;
  const map = new Map<string, RcaPointer>();
  for (const p of [...code, ...handoff]) {
    const k = key(p);
    const existing = map.get(k);
    if (!existing || p.confidence > existing.confidence) map.set(k, p);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}
```

---

## Report-only path (cluster / namespace health)

**Problem today:** cluster health queries start a full diagnose run; brain returns `noop`; user gets “No automated action recommended” instead of the health summary.

**Fix (immediate — commander sync path):**

```text
Telegram: "what is cluster health?"
    → commander detects investigateScope cluster | namespace
    → GET investigator /facts (code)
    → formatHealthInvestigationReport()  ← no orchestrator, no brain
    → immediate Telegram reply
```

**Fix (with handoff schema):**

```json
{
  "intent": "report",
  "scope": { "investigateScope": "cluster", "namespace": "_all", "resourceName": "_cluster" },
  "rcaPointers": [ ... from gatherClusterHealthFacts ... ],
  "observabilitySummary": "Cluster overview: 3 nodes, 1 deployment not ready..."
}
```

Same payload shape whether facts come from code or Holmes.

---

## Bounded agentic pass-2 (future)

```text
Pass 1: code gather → rcaPointers
Pass 2: brain /plan-hypotheses → hypotheses[] + followUpQueries[] (max 3)
Pass 3: investigator runs allowlisted followUpQueries → more pointers
Pass 4: brain /plan-only → RemediationPlan
```

`followUpQueries[].queryId` maps to entries in `shared/src/observability-query.ts` — **not** free-form LLM PromQL.

Handoff schema carries pass-2 output between steps.

---

## Security

| Field | Brain sees? | Storage |
|-------|-------------|---------|
| `rcaPointers` | Yes (sanitized) | Run store |
| `observabilitySummary` | Yes | Run store |
| `operatorNotes` | No (unless sanitized) | Audit only |
| `provenance.toolTrace` | No | Audit only |
| `suggestedPlan` | Hint only; brain must re-validate | Run store |

External handoffs must pass `security-agent` sanitize before merge.

---

## Example: cluster health report

```json
{
  "schemaVersion": "1.0",
  "source": "investigator_code",
  "incidentId": "abc-123",
  "receivedAt": "2026-05-29T12:00:00Z",
  "intent": "report",
  "scope": {
    "investigateScope": "cluster",
    "namespace": "_all",
    "resourceKind": "Deployment",
    "resourceName": "_cluster"
  },
  "confidence": 0.9,
  "rcaPointers": [
    {
      "source": "kubernetes",
      "title": "Cluster overview",
      "summary": "3 nodes, 1 deployment not fully ready",
      "findings": [
        "default/payment-api: 0/2 ready",
        "2 recent Warning events"
      ],
      "confidence": 0.92
    }
  ],
  "observabilitySummary": "[kubernetes] Cluster overview: 3 nodes, 1 deployment not fully ready\n  - default/payment-api: 0/2 ready"
}
```

Commander formats this for Telegram (~20 lines max).

---

## Example: Holmes external handoff

```json
{
  "schemaVersion": "1.0",
  "source": "holmes",
  "incidentId": "def-456",
  "receivedAt": "2026-05-29T12:05:00Z",
  "intent": "remediate",
  "scope": {
    "investigateScope": "workload",
    "namespace": "production",
    "resourceKind": "Deployment",
    "resourceName": "checkout-api"
  },
  "confidence": 0.78,
  "rcaPointers": [
    {
      "source": "prometheus",
      "title": "Memory saturation",
      "summary": "Container memory at limit for 15m",
      "findings": ["kube_pod_container_resource_limits_memory_bytes exceeded"],
      "confidence": 0.85
    },
    {
      "source": "loki",
      "title": "OOMKilled",
      "summary": "Signal lines show OOMKilled exit 137",
      "findings": ["OOMKilled", "Memory limit exceeded"],
      "confidence": 0.9
    }
  ],
  "suggestedPlan": {
    "action": "git_patch",
    "rootCause": "Memory limit too low for checkout-api workload",
    "severity": "HIGH"
  },
  "provenance": {
    "model": "claude-sonnet-4",
    "turnCount": 8,
    "durationMs": 45000
  }
}
```

sre-bot brain validates and may change `action`; security + HIL still apply.

---

## Implementation checklist

| Step | Component | Status |
|------|-----------|--------|
| Schema types in `shared/src/rca-handoff.ts` | shared | Pending |
| `formatHealthInvestigationReport()` | shared | **Done** (sync chat path) |
| Commander sync cluster/namespace health | commander | **Done** |
| `StartRunRequest.rcaHandoff` field | shared | Pending |
| Orchestrator merge + report-only intent | orchestrator | Pending |
| `POST /runs/:id/rca-handoff` | orchestrator | Pending |
| Holmes adapter | integrations | Pending |
| Console run detail — show handoff provenance | console | Pending |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-05-29 | Initial handoff schema design; report-only cluster health note |
