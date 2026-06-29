# K8s failure fixtures (Kind / OpenShift eval)

Deterministic workloads that reproduce common failure signatures for runbook eval and golden-path testing.

## Apply

```bash
chmod +x scripts/k8s-failure-fixtures/*.sh
./scripts/k8s-failure-fixtures/apply-all.sh
```

Uses `kubectl` by default; set `KUBECTL=oc` on OpenShift.

## Teardown

```bash
./scripts/k8s-failure-fixtures/teardown.sh
```

## Fixture map

See `fixtures.json` — each entry links `fixture_id` → manifest → `error_signature`.

| Fixture | Signature |
|---------|-----------|
| `crash_loop` | CrashLoopBackOff |
| `oom_killed` | OOMKilled |
| `image_pull_backoff` | ImagePullBackOff |
| `failed_scheduling` | FailedScheduling |
| `config_error` | CreateContainerConfigError |
| … | … |

## Chat eval example

After apply:

```
investigate deployment fixture-crash-loop in sre-fixture-lab
```

Expected: agent diagnoses CrashLoopBackOff and cites gitops/compute runbook.

## Corpus validation

```bash
npm run runbooks:validate
```

Ensures every fixture_id in taxonomy has a manifest here.
