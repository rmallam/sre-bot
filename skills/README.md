# Runbook knowledge (pgvector only)

Verified remediation knowledge lives in the **platform RAG store** (`sre_runbooks` in `rag-postgres`), not in files on disk.

**Corpus source (git):** `shared/data/runbooks/*.json` + `shared/data/k8s-issue-taxonomy.json`

```bash
npm run runbooks:validate    # schema + taxonomy sync
npm run runbooks:scrape      # merge k8s-doc-sources.json into runbooks/
npm run runbooks:sync-taxonomy
npm run runbooks:ingest      # bulk POST /rag/learn
npm run runbooks:fixtures    # GP-RB golden-path eval
./scripts/k8s-failure-fixtures/apply-all.sh   # Kind eval fixtures
```

## How learning works

When a remediation is **verified** (`worked: true`), the orchestrator upserts a runbook via `POST /rag/learn` on `platform-agent` (requires `SRE_RAG_LEARNING=true`).

## How brain uses runbooks

Before planning, brain calls `POST /rag/query` through `shared/skills-loader.ts`, passing incident context (mode, resource, repo, error signature). Top-k matching runbooks are injected into the system prompt.

Required env on **brain-agent** and **orchestrator-agent**:

- `SRE_PLATFORM_URL=http://platform-agent:8080`
- `SRE_RAG_GROUNDING=true` (brain retrieval)
- `SRE_RAG_LEARNING=true` (orchestrator upsert on success)

## Bootstrap seed runbooks

Use the platform bootstrap script to seed initial runbooks into pgvector:

```bash
docker compose exec platform-agent python -m scripts.bootstrap_rag
```

See `sre-agent-platform/README.md` for migrations and manual `/rag/learn` examples.

## Console export

**Export skills** in the Operations Console still copies markdown snippets for human review. Those snippets are **not** auto-written to disk — paste into bootstrap or call `/rag/learn` to add them to the vector store.
