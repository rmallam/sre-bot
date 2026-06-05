# sre-bot Helm chart

Deploys the full SRE Bot stack with **parity to `docker-compose.yml`**:

| Component | Compose service | Helm resource |
|-----------|-----------------|---------------|
| Run store DB | `postgres` | `postgres` StatefulSet |
| Session store | `redis` | `redis` Deployment |
| RAG vector DB | `rag-postgres` | `rag-postgres` StatefulSet |
| Semantic platform | `platform-agent` | `platform-agent` Deployment |
| Event watcher | `watcher-agent` | `watcher-agent` Deployment |
| Chat / routing | `commander-agent` | `commander-agent` Deployment |
| Investigation | `investigator-agent` | `investigator-agent` Deployment |
| LLM reasoning | `brain-agent` | `brain-agent` Deployment |
| Workflow hub | `orchestrator-agent` | `orchestrator-agent` Deployment |
| Security scan | `security-agent` | `security-agent` Deployment |
| K8s apply | `executor-agent` | `executor-agent` Deployment |
| Approvals | `hil-agent` | `hil-agent` Deployment |
| GitOps deploy | `gitops-agent` | `gitops-agent` Deployment |
| CI/CD | `cicd-agent` | `cicd-agent` Deployment |
| Code fixes | `coding-agent` | `coding-agent` Deployment |
| Web console | `console-agent` | `console-agent` Deployment |

**Not included** (compose profiles only): `kube-proxy`, `ai-gateway`.

## Prerequisites

- Kubernetes 1.25+
- Helm 3.10+
- Images published to GHCR (via GitHub Actions on `main`)
- For **private** GHCR packages: create a pull secret and set `global.imagePullSecrets`

```bash
kubectl create secret docker-registry ghcr-credentials \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USER \
  --docker-password=YOUR_GITHUB_PAT \
  -n sre-bot-system
```

## Quick install

```bash
cp helm/sre-bot/values-local.example.yaml my-values.yaml
# Edit secrets and optional LOKI_URL / PROMETHEUS_URL

helm upgrade --install sre-bot ./helm/sre-bot \
  -f my-values.yaml \
  --namespace sre-bot-system \
  --create-namespace \
  --wait
```

## Image reference

Default images match CI output:

```text
ghcr.io/<imageOwner>/sre-bot-<agent>:<imageTag>
```

Special image names (same registry/tag pattern):

| Agent | Image repository |
|-------|------------------|
| platform | `sre-bot-platform` |
| coding | `sre-bot-coding-agent` |
| cicd | `sre-bot-cicd` |

| Value | Default |
|-------|---------|
| `global.imageOwner` | `rmallam` |
| `global.imageTag` | `main` |

## Required secrets

Set in `my-values.yaml` under `secrets:` (or use `secrets.existingSecret`):

| Key | Used by |
|-----|---------|
| `openrouterApiKey` | brain, commander, platform |
| `geminiApiKey` | brain, commander, platform (optional) |
| `openaiApiKey` | platform RAG embeddings (optional) |
| `gitopsRepoUrl` | investigator, gitops |
| `allowedUsers` | commander |
| `telegramBotToken` / `telegramAlertChatId` | commander, hil |
| `githubToken` | gitops, cicd, coding |
| `deployAppRepoWriteToken` | cicd, coding (optional) |
| `githubWebhookSecret` | commander GitHub webhooks (optional) |
| `gitSshPrivateKey` | investigator, gitops (Git SSH clone) |

## Skills volume (brain + coding-agent)

Mount a ConfigMap of skills at `/data/skills`:

```yaml
skills:
  configMapName: sre-bot-skills
```

## Useful values

```yaml
global:
  imageTag: main
  imagePullSecrets:
    - name: ghcr-credentials

runStore:
  backend: postgres   # postgres | redis | file

redis:
  enabled: true

ragPostgres:
  enabled: true

session:
  chatBackend: redis
  caseBackend: redis

agentMode:
  sreAgentMode: classic
  platformRouting: true
  ragGrounding: true
  ragLearning: true

investigator:
  lokiUrl: "http://loki.monitoring:3100"
  prometheusUrl: "http://prometheus.monitoring:9090"

ingress:
  hil:
    enabled: true
    host: hil.example.com
  console:
    enabled: true
    host: console.example.com

orchestrator:
  registryDryRun: "true"   # K8s safety default; set "false" for real applies
```

## Upgrade

```bash
helm upgrade sre-bot ./helm/sre-bot -f my-values.yaml -n sre-bot-system
```

## Uninstall

```bash
helm uninstall sre-bot -n sre-bot-system
# CRD and ClusterRoles remain unless deleted manually
```

## Validate templates locally

```bash
helm template sre-bot ./helm/sre-bot -f helm/sre-bot/values-local.example.yaml
```
