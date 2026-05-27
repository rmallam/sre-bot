# Intent -> Plan -> Tool Compiler Roadmap

This roadmap moves the platform from fixed action branching to a typed, dynamic tool-orchestration runtime while preserving production guardrails.

## Current baseline

- Intent: commander regex + optional LLM routing + deploy strategy chooser
- Plan: orchestrator + brain action enum (`restart`, `git_patch`, `helm_deploy`, `repo_apply`)
- Compile: `compileAndValidatePlan()` → multi-step tool pipeline
- Act: `executeCompiledPlan()` with retries, transcript, dry-run metadata
- Guardrails: security-agent authorize, plan-level policy, per-tool policy, HIL

## Target model

1. Normalize free-form intent to a typed objective
2. Produce a capability-safe plan
3. Compile plan to typed tool calls
4. Execute via runtime with per-tool policy checks and structured retries
5. Verify and loop

## Phased implementation

### Phase 1 — done

- Typed tool-call contracts (`shared/src/tool-contracts.ts`)
- `compilePlanToToolCalls()` in orchestrator
- Execute through compiled calls

### Phase 2 — done

- Tool registry (`shared/src/tool-registry.ts`) with risk/dry-run/retry metadata
- Input validation (`shared/src/tool-validation.ts`)
- `compileAndValidatePlan()` with confidence + fallback
- Per-tool policy (`shared/src/tool-policy.ts`)
- Tool runtime dispatcher with retries + idempotency keys
- `GET /tools` catalog endpoint
- Registry-driven dry-run for `repo_apply` via `executionOptions.dryRun`

### Phase 3 — done

- Multi-step pipeline: `repo_inspect` → `apply/restart` → `verify_health` → `notify`
- Structured run transcript (`ToolTranscriptEntry`) stored per run
- `GET /runs/:runId` returns transcript + compiled tools
- Verify node consumes transcript (no duplicate verify when already run)

### Phase 4 — done

- Capability-first planning: `POST /plan-capability` on brain, `USE_CAPABILITY_PLANNER=true` on orchestrator
- Persistent run store: Postgres (default in compose), Redis, or file (`RUN_STORE_BACKEND`, `DATABASE_URL`)
- Per-tool HIL: `PER_TOOL_HIL=true` pauses before high-risk tools in prod; resume via `/resume-run`
- Argo tools: `argo.wait_sync`, `argo.rollout_promote` (gitops `/argo/*` endpoints)
- `GET /runs` list + `GET /runs/:runId` full transcript from durable store

## Tool catalog (v1)

| Tool | Risk | Dry-run | Typical step |
|------|------|---------|--------------|
| `investigator.repo_inspect` | low | no | pre-deploy read-only |
| `executor.restart_workload` | low | no | diagnose |
| `gitops.apply_plan` | high | yes | patch/deploy |
| `investigator.verify_health` | low | no | post-act |
| `commander.notify` | low | no | post-act |
| `argo.wait_sync` | low | no | post-gitops |
| `argo.rollout_promote` | high | no | canary promote |

## Non-goals

- No direct LLM shell execution
- No bypass of security-agent or policy/HIL gates
- No untyped tool payloads

## Env

| Variable | Default | Purpose |
|----------|---------|---------|
| `REGISTRY_DRY_RUN` | `true` | Enable dry-run for tools that support it |
| `DIRECT_DEPLOY_DRY_RUN` | `true` | Fallback for direct kubectl/helm apply |
| `RUN_STORE_BACKEND` | auto | `postgres`, `redis`, or file fallback |
| `DATABASE_URL` | — | Postgres connection for run store |
| `USE_CAPABILITY_PLANNER` | `false` | LLM tool catalog planning for diagnose mode |
| `PER_TOOL_HIL` | `false` | Pause before each high-risk tool in prod |
