# sre-bot Helm chart

Deploys all nine SRE agents, Postgres (run transcript store), optional Redis, RBAC, CRD, and secrets.

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
# Copy and edit secrets (do not commit)
cp helm/sre-bot/values-local.example.yaml my-values.yaml

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

| Value | Default |
|-------|---------|
| `global.imageOwner` | `rmallam` |
| `global.imageTag` | `main` |

## Required secrets

Set in `my-values.yaml` under `secrets:` (or use `secrets.existingSecret`):

| Key | Used by |
|-----|---------|
| `geminiApiKey` | brain, commander |
| `gitopsRepoUrl` | investigator, gitops |
| `allowedUsers` | commander |
| `gitSshPrivateKey` | investigator, gitops (Git SSH clone) |

Investigator ClusterRole includes read access for chat `get` commands: namespaces, pods, deployments, nodes, services, events.
| `telegramBotToken` / `slackBotToken` | commander, hil (optional) |
| `githubToken` | gitops (optional, HTTPS push) |

## Useful values

```yaml
global:
  imageTag: main
  imagePullSecrets:
    - name: ghcr-credentials

runStore:
  backend: postgres   # postgres | redis | file

postgres:
  enabled: true
  auth:
    password: CHANGE_ME

ingress:
  hil:
    enabled: true
    host: hil.example.com
    className: nginx

orchestrator:
  autonomyMode: low_risk_only
  registryDryRun: "true"   # set "false" for real applies
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

## Disable bundled Postgres

Use an external database:

```yaml
postgres:
  enabled: false
runStore:
  backend: postgres
# Pass DATABASE_URL via orchestrator extra env (future) or patch deployment
```

For now, keep `postgres.enabled: true` unless you patch `orchestrator-agent` with an external `DATABASE_URL`.
