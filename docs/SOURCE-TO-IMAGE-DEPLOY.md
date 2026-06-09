# Source-to-Image Deploy (DEPLOY-2)

Deploy **bare application repos** (no Dockerfile, no K8s manifests) by detecting runtime → building image → applying generated Helm.

Related: [PLATFORM-LAYERS.md](./PLATFORM-LAYERS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRODUCT-ROADMAP.md](./PRODUCT-ROADMAP.md)

**Status:** Phase 2 coded — in-cluster builds (Kaniko/pack/S2I), orchestrator build node, HIL gate.

---

## Problem

Today when a repo has no manifests, `helm-generator` scaffolds a chart pointing at:

```text
ghcr.io/org/app:latest   ← often does not exist
```

Result: `ImagePullBackOff`.

---

## S2I model (Red Hat) adapted for sre-bot

```text
/deploy github.com/org/bare-node-app to staging
    → clone repo
    → detect runtime (package.json → nodejs)
    → needsImageBuild = true
    → source build plugin (buildpacks | OpenShift S2I | Dockerfile)
    → push to IMAGE_REGISTRY
    → helm-generator with real image ref
    → gitops / direct apply
    → verify
```

**Code-driven** — LLM does not run builds. Build plugins are typed tools behind HIL.

---

## Phase 1 (shipped in code)

| Module | Role |
|--------|------|
| `shared/src/deploy/runtime-detect.ts` | Detect node/python/go/java; set `needsImageBuild`, `buildStrategy` |
| `shared/src/deploy/source-build.ts` | `SourceBuildPlugin` interface + plan stub |
| `shared/src/deploy/build-plan.ts` | Merge build into `RemediationPlan` |
| `investigator/pre-deploy.ts` | Uses `enrichRepoSignals()` |
| `orchestrator/deploy-plan.ts` | Calls `buildDeployPlanWithSourceBuild` when `needsImageBuild` |

---

## Phase 2 (shipped in code)

| Item | Module |
|------|--------|
| **DEPLOY-2b** | `investigator/source-build-runner.ts` + `POST /build/from-source` — Kaniko (Dockerfile), pack Job (buildpacks) |
| **DEPLOY-2c** | OpenShift `BuildConfig` + S2I builder images in `source-build-runner.ts` |
| **DEPLOY-2d** | Orchestrator `sourceBuild` node before `plan` on pre-deploy (`source-build-node.ts`) |
| **DEPLOY-2e** | HIL gate via `SOURCE_BUILD_REQUIRE_HIL` + `SOURCE_BUILD_TRUSTED_REPOS` |

---

## Future

| Item | Description |
|------|-------------|
| — | Image scan before deploy; build cache; private registry bootstrap for kind |

---

## Configuration

```bash
# Enable actual builds (default false — plan-only)
SOURCE_BUILD_ENABLED=false

# Require HIL before building from Git (default true)
SOURCE_BUILD_REQUIRE_HIL=true
# SOURCE_BUILD_TRUSTED_REPOS=github.com/my-org/apps

# buildpacks | s2i | skip
SOURCE_BUILD_STRATEGY=buildpacks

# Target registry for built images
IMAGE_REGISTRY=ghcr.io/my-org

# Optional builder overrides
BUILDPACK_NODE_BUILDER=paketobuildpacks/builder-jammy-base
OPENSHIFT_API_URL=          # enables S2I plugin when set
OPENSHIFT_TOKEN=
PACK_CLI_PATH=              # optional local pack; otherwise in-cluster pack Job
IMAGE_PUSH_SECRET=          # K8s secret for registry push in build Jobs
SOURCE_BUILD_NAMESPACE=     # namespace for build Jobs
```

---

## RepoSignals extension

```typescript
detectedRuntime?: 'nodejs' | 'python' | 'go' | ...
needsImageBuild?: boolean;
buildStrategy?: 'existing-dockerfile' | 'buildpacks' | 's2i' | 'skip';
```

---

## Security

- Builds arbitrary GitHub repos → **HIL required** before build (DEPLOY-2e)
- Allowlist namespaces / repos
- Scan built image before deploy (future)

---

## Changelog

| Date | Change |
|------|--------|
| 2026-06-05 | DEPLOY-2 Phase 2: Kaniko/pack/S2I builds, orchestrator build node, source-build HIL gate |
| 2026-06-01 | DEPLOY-2 Phase 1: runtime-detect, source-build plugins, build-plan wiring |
