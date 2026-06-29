# K8s / OpenShift runbook corpus

Split by `target_component`. Each file is a JSON array of:

```json
{
  "error_signature": "ImagePullBackOff",
  "target_component": "gitops",
  "playbook_markdown": "# Title\n\n## Symptoms\n...\n\n## Diagnosis\n...\n\n## Remediation\n...\n\n## Verification\n..."
}
```

## Files

| File | Domain |
|------|--------|
| `compute.json` | Workloads, scheduling, probes, DR/advisory |
| `gitops.json` | Image pull, Helm, rollouts, sync |
| `storage.json` | PVC, mounts, StorageClass |
| `network.json` | DNS, ingress, TLS, NetworkPolicy |
| `database.json` | Failover, replication, disk |
| `security.json` | SCC, RBAC, secrets, PSA |

## Taxonomy

`shared/data/k8s-issue-taxonomy.json` maps each signature to severity, optional `fixture_id`, and sources.

## Tooling

```bash
npm run runbooks:validate          # schema + taxonomy sync
npm run runbooks:scrape            # import from k8s-doc-sources.json
npm run runbooks:sync-taxonomy     # regenerate taxonomy from runbooks
npm run runbooks:ingest            # bulk POST /rag/learn (needs platform)
npm run runbooks:fixtures          # GP-RB golden-path fixture eval
./scripts/k8s-failure-fixtures/apply-all.sh   # Kind eval fixtures
```

Legacy monolithic `sre-rag-runbooks.json` is replaced by this directory. Bootstrap and ingest scripts load from here.
