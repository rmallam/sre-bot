# Kube SRE Autonomous Agent Platform

Enterprise-grade autonomous SRE bot with LangGraph orchestration, security-agent gates, restart-first remediation, dual-repo Helm deploy, and direct source-repo deploy mode.

## Architecture

Full diagrams, workflows, and agent interactions:

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

Compiler migration roadmap:

**[docs/TOOL-COMPILER-ROADMAP.md](docs/TOOL-COMPILER-ROADMAP.md)**

OpenRouter multi-model + MCP guidance:

**[docs/LLM-AND-MCP.md](docs/LLM-AND-MCP.md)**

**Product roadmap (all tracks):** **[docs/PRODUCT-ROADMAP.md](docs/PRODUCT-ROADMAP.md)**

**HolmesGPT comparison & adoption:** **[docs/HOLMES-COMPARISON-AND-ADOPTION.md](docs/HOLMES-COMPARISON-AND-ADOPTION.md)**

```
Slack/Telegram → commander → orchestrator (LangGraph)
Watcher ──────────────────────┘
  observe → sanitize → plan → authorize → policy → act → verify → retry
Tools: investigator | security | brain | executor | gitops | hil
```

## Agents

| Agent | Port | Role |
|-------|------|------|
| watcher | 8080 | Anomaly detection → orchestrator |
| commander | 8081 | PA intake, notify |
| investigator | 8082 | Facts, verify |
| brain | 8083 | LLM plan-only (`/plan-only`) |
| orchestrator | 8084 | LangGraph loop + persistent run transcripts (`GET /runs/:id`) |
| hil | 8085 | Approvals + resume |
| gitops | 8086 | Git patch + Helm dual push + direct repo apply |
| executor | 8087 | Rollout restart |
| security | 8088 | Sanitize + authorize |
| cicd | 8089 | GitHub Actions triage, rerun, open issue |
| **console** | **8091** | **Operations Console — approvals, runs, ignore list** |

DevOps / CI/CD phases: **[docs/DEVOPS-AGENT-PHASES.md](docs/DEVOPS-AGENT-PHASES.md)**

Conversational UX (natural chat): **[docs/CONVERSATIONAL-UX-ROADMAP.md](docs/CONVERSATIONAL-UX-ROADMAP.md)**

Operations Console (web UI): **[docs/OPERATIONS-CONSOLE.md](docs/OPERATIONS-CONSOLE.md)**

Deep RCA (multi-source investigation): **[docs/DEEP-RCA.md](docs/DEEP-RCA.md)**

RCA handoff schema (PLAT-12, Holmes bridge): **[docs/RCA-HANDOFF-SCHEMA.md](docs/RCA-HANDOFF-SCHEMA.md)**

Platform layers (reusable packages, PLAT-14): **[docs/PLATFORM-LAYERS.md](docs/PLATFORM-LAYERS.md)**

Source-to-image deploy (DEPLOY-2): **[docs/SOURCE-TO-IMAGE-DEPLOY.md](docs/SOURCE-TO-IMAGE-DEPLOY.md)**

## Quick Start

```bash
cp secrets.example.yaml .env.local
# fill OPENROUTER_API_KEY, GITOPS_REPO_URL, ALLOWED_USERS, etc.

export $(grep -v '^#' .env.local | xargs)

# Podman Desktop: cluster API is on the host (e.g. https://127.0.0.1:50750).
# Containers reach it via host.containers.internal — no kube-proxy required.

# Podman (recommended): clean start avoids stale dependency errors
./scripts/compose-up.sh

# Or manually:
# podman compose down --remove-orphans && podman compose up --build
```

HIL dashboard (legacy): http://localhost:8085/legacy

**Operations Console:** http://localhost:8091 — manage approvals, runs, and ignored resources alongside Telegram/Slack.

**Ignore incidents:** On any approval card (Telegram, Slack, or Operations Console), tap **Ignore** to suppress future remediation for that workload. Ignored resources are stored in HIL and skipped by the watcher, orchestrator, and new approval requests. Manage the list under **Ignored** in the console.

## Suggest your own fix (HIL)

For every pending incident you can override the bot plan:

- **Telegram**: tap **Suggest fix** on the approval message, then reply (e.g. `restart`, `add imagePullSecrets ghcr-creds`, `set image to ghcr.io/org/app:v2`). You get a parsed plan preview, then **Apply my fix** or **Approve**.
- **Web**: open the [Operations Console](http://localhost:8091) — each card has a **Suggest your own fix** form (update plan or apply immediately).

Suggestions are parsed with fast rules when possible, otherwise **brain** `POST /suggest-plan` (LLM). The stored approval plan is replaced before execution.

## Direct cluster patch (no GitOps)

For approved `git_patch` fixes you can apply changes **straight to the cluster** (Deployment/StatefulSet JSON patch) without committing to a GitOps repo:

| `GITOPS_PATCH_MODE` | Behavior |
|---------------------|----------|
| `cluster` | **Default in compose.** Live API patch only; no mirror/Argo. |
| `gitops` | GitOps mirror + push only (`GITOPS_REPO_URL` required). |
| `auto` | Cluster first; fall back to GitOps mirror only when `GITOPS_REPO_URL` is set. |

Set in `.env.local` (see `secrets.example.yaml`). Operator suggestions from **Suggest fix** default to `patchTarget: cluster` on the plan.

Per-plan override: `"patchTarget": "cluster"` on `RemediationPlan` (e.g. from brain or HIL).

Legacy: `GITOPS_CLUSTER_PATCH_FIRST=false` forces gitops-only when mode is `auto`.

## Namespace creation (deploy)

If the target namespace does not exist, the bot **asks before creating it** (Telegram buttons or reply `yes` / `create namespace`). After you approve, gitops runs `kubectl apply` for the Namespace, then continues the deploy.

## Failure analyst (deploy / act errors)

When a deploy or remediation step fails, the orchestrator calls **brain** `POST /analyze-failure` (LLM + deterministic fallback). The model decides **retry with a changed plan** (e.g. different git branch) or **escalate** — it does not blindly run Helm after a kubectl TLS error. Disable with `FAILURE_ANALYSIS_ENABLED=false`.

## Post-deploy verification recovery (reusable)

After apply succeeds, unhealthy pods are classified by a reusable artifact (`shared/src/post-deploy-recovery.ts`):
- `auto_retry` for safe transient issues (single restart attempt)
- `ask_confirmation` when a retry may help but is uncertain (e.g. image pull failures)
- `none` to escalate with a clear reason

This prevents post-deploy runtime issues from being misclassified as apply failures.

## CI/CD triage (GitHub Actions)

Ask in Telegram/Slack:

- `why did CI fail on github.com/org/repo`
- `ci failure rmallam/sre-bot on branch main`
- `ci failure github.com/org/repo run #12345`

The bot fetches the failed workflow run, classifies the log (tests, lint, auth, runner, etc.), sends a diagnosis, and may suggest **re-run** or **open a tracking issue** (HIL approval required under default autonomy).

**Webhook (optional):** point GitHub `workflow_run` events to `POST http://<commander>:8081/webhooks/github` with `GITHUB_WEBHOOK_SECRET` set. Failed runs auto-start a `ci-failure` orchestrator run and notify `TELEGRAM_ALERT_CHAT_ID`.

Set `GITHUB_TOKEN` (repo + Actions read, contents write, issues write) and mount team runbooks under `./skills/*.md` for brain prompt context.

**Dependency / missing-package failures (Phase 1):** the bot can propose a **code/deps PR** via brain + HIL — see [docs/CI-CODE-REMEDIATION-ROADMAP.md](docs/CI-CODE-REMEDIATION-ROADMAP.md).

**Coding agent (Phase 2, planned):** multi-file logic fixes with build/test loop — see roadmap.

## Autonomy

- `AUTONOMY_MODE=low_risk_only` (default): auto restart/deploy in non-prod; HIL for patches and prod deploys
- `AUTONOMY_MODE=full`: more auto actions (prod Helm still needs HIL)
- `AUTONOMY_MODE=hil_all`: every act needs approval

## Security (v1)

- All LLM input via `security-agent` `/sanitize-for-llm`
- All actions via `/authorize-action`
- Investigator `INVESTIGATOR_SAFE_MODE=true` minimizes logs
- See [docs/security/OWASP-LLM-control-matrix.md](docs/security/OWASP-LLM-control-matrix.md)

## Deploy flow

1. User: `deploy github.com/org/app on branch main`
2. Commander inspects repo and asks strategy (GitOps vs Direct) unless explicit flags are used
3. Orchestrator compiles a multi-step tool pipeline:
   - `repo_inspect` → `apply_plan` → `verify_health` → `notify`
4. Policy gates (plan + per-tool) then auto-execute or HIL
5. Full transcript available at `GET /runs/:runId`

## Telegram examples

```
deploy httpd in simple namespace
deploy nginx container to staging namespace
deploy github.com/your-org/your-app on branch feature/x
deploy github.com/bitnami/charts --namespace sandbox --no-git-push
get all namespaces
get pods in staging
what's wrong with production/payments-api?
rollback staging/frontend
```

If you omit strategy flags, the bot now inspects the repo first and asks you to choose:
- `gitops` (push + Argo CD)
- `direct` (apply from source repo, no Git push)
- `cancel`

On Telegram this choice is shown with inline buttons.

## Kubernetes (Helm)

Deploy all agents into your cluster:

```bash
cp helm/sre-bot/values-local.example.yaml my-values.yaml
# edit secrets in my-values.yaml

helm upgrade --install sre-bot ./helm/sre-bot \
  -f my-values.yaml \
  --namespace sre-bot-system \
  --create-namespace \
  --wait
```

Chart docs: [helm/sre-bot/README.md](helm/sre-bot/README.md)

Legacy Kustomize manifests under `k8s/` are partial; prefer Helm for a full stack.

## Container images (GHCR)

On push to `main` or version tags (`v*`), GitHub Actions builds and publishes images to GHCR:

```text
ghcr.io/<github-owner>/sre-bot-<agent>:<tag>
```

Agents: `watcher`, `commander`, `investigator`, `brain`, `orchestrator`, `hil`, `gitops`, `executor`, `security`.

**One-time setup**

1. Repo **Settings → Actions → General** → Workflow permissions: **Read and write**
2. After first publish: **Packages** → each image → **Package settings** → visibility (public/private)

Pull an image:

```bash
docker pull ghcr.io/<owner>/sre-bot-orchestrator:main
```

For private packages, log in with a PAT that has `read:packages`:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin
```

## v2 (optional)

- `docker compose --profile v2` — AI gateway placeholder
- `policy/authorize.rego` — OPA policies
- `SIEM_ENDPOINT` — audit event export
