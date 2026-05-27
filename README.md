# Kube SRE Autonomous Agent Platform

Enterprise-grade autonomous SRE bot with LangGraph orchestration, security-agent gates, restart-first remediation, dual-repo Helm deploy, and direct source-repo deploy mode.

## Architecture

Full diagrams, workflows, and agent interactions:

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

Compiler migration roadmap:

**[docs/TOOL-COMPILER-ROADMAP.md](docs/TOOL-COMPILER-ROADMAP.md)**

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

## Quick Start

```bash
cp secrets.example.yaml .env.local
# fill GEMINI_API_KEY, GITOPS_REPO_URL, ALLOWED_USERS, etc.

export $(grep -v '^#' .env.local | xargs)
docker-compose up --build
```

HIL dashboard: http://localhost:8085

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
deploy github.com/your-org/your-app on branch feature/x
deploy github.com/bitnami/charts --namespace sandbox --no-git-push
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
