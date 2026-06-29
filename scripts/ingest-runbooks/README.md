# Runbook ingest tooling

Validate, scrape, and load the K8s/OpenShift runbook corpus into platform RAG.

## Validate

```bash
npm run runbooks:validate
```

## Scrape from K8s doc sources

Curated URLs and seed sections live in `shared/data/k8s-doc-sources.json`.

```bash
# Merge seed_sections into shared/data/runbooks/*.json (offline, no network)
npm run runbooks:scrape

# Fetch live HTML into shared/data/runbook-imports/cache/ then merge
npm run runbooks:scrape:fetch

# Preview without writing
npx tsx scripts/ingest-runbooks/scrape-normalize.ts --dry-run --merge

# Overwrite existing signatures
npx tsx scripts/ingest-runbooks/scrape-normalize.ts --force --merge
```

After adding runbooks manually or via scrape:

```bash
npm run runbooks:sync-taxonomy
npm run runbooks:validate
```

## Bulk learn (pgvector)

```bash
export SRE_PLATFORM_URL=http://localhost:9090
npm run runbooks:ingest
```

## Golden-path fixture eval

```bash
./scripts/k8s-failure-fixtures/apply-all.sh
npm run runbooks:fixtures
# also runs at end of ./scripts/test-golden-paths.sh (GP-RB)
```

GP-RB checks:
- Corpus + unit tests (offline)
- Platform `/rag/ground` for top signatures (needs seeded RAG)
- Kind fixture unhealthy states via investigator
- Commander investigate chat for crash-loop + image-pull fixtures

## CI (GitHub Actions)

| Workflow | When | What |
|----------|------|------|
| [`runbook-corpus-sync.yml`](../../.github/workflows/runbook-corpus-sync.yml) | Weekly + manual | Scrape doc sources → validate → open PR |
| Same workflow `validate` job | PR touching runbooks | Offline GP-RB (`npm run runbooks:ci`) |
| [`ci.yml`](../../.github/workflows/ci.yml) | Every PR | `npm run runbooks:validate` |

Manual dispatch: **Actions → Runbook corpus sync → Run workflow**

```bash
npm run runbooks:ci   # local offline gate (same as PR validate job)
```

## Corpus layout

See `shared/data/runbooks/README.md`.
