# SRE Agent Platform (Python)

Gold-standard **semantic routing**, **pgvector RAG grounding**, and **LangGraph** workflow layer for the Kube SRE Autonomous Agent.

Complements the existing TypeScript microservices (`commander`, `orchestrator`, `brain`, `investigator`) — wire this layer as the Python entrypoint or embed nodes into orchestrator via HTTP sidecar.

## Layout

```
sre-agent-platform/
├── gateway/semantic_router.py   # semantic-router intent classifier
├── rag/
│   ├── pg_vector_store.py       # EDB Postgres + pgvector hybrid search
│   └── retriever.py             # Embedding + runbook lookup
├── graph/
│   ├── state.py                 # SREAgentState (TypedDict + add_messages)
│   ├── nodes.py                 # rag_grounding_node, semantic_route_node, …
│   └── workflow.py              # Compiled LangGraph topology
├── config.py                    # pydantic-settings env config
└── migrations/001_sre_runbooks.sql
```

## Topology

```text
START → semantic_route → gather → rag_grounding → plan → act → verify
                              ↑__________________________|
                              (verify retry, capped by verification_attempts)
```

## Quick start

```bash
cd sre-agent-platform
python -m venv .venv && source .venv/bin/activate
pip install -e ".[google]"   # or omit [google] for OpenAI-only

export OPENAI_API_KEY=...
export SRE_RAG_DATABASE_URL=postgresql://sre:sre@localhost:5432/sre_rag
psql "$SRE_RAG_DATABASE_URL" -f migrations/001_sre_runbooks.sql

python -c "
from graph.workflow import run_workflow
print(run_workflow('investigate OOMKilled in payments-api', detected_error='OOMKilled'))
"
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `SRE_ROUTER_ENCODER` | `openai` | `openai` or `google` for semantic-router |
| `SRE_ROUTER_SCORE_THRESHOLD` | `0.70` | Fallback when similarity below threshold |
| `SRE_RAG_DATABASE_URL` | local postgres | EDB/CNPG pgvector instance |
| `SRE_EMBEDDING_PROVIDER` | `openai` | Embedding API for RAG |
| `SRE_RAG_LEARNING` | `true` | Upsert verified fixes after successful remediation |
| `SRE_MAX_VERIFICATION_ATTEMPTS` | `5` | Infinite-loop guard |

## Integration with existing TS stack

| Python module | Replace / augment |
|---------------|-----------------|
| `gateway/semantic_router.py` | `commander` `llm-router.ts` fast-path |
| `rag/retriever.py` | New — inject into `orchestrator` before `planNode` |
| `graph/nodes.rag_grounding_node` | Insert between `agentFinalize`/`sanitize` and `plan` in `graph.ts` |
| `graph/state.py` | Mirror fields in LangGraph `RunAnnotation` |

## Integration with TypeScript stack (wired)

| Service | Env | Behavior |
|---------|-----|----------|
| **platform-agent** `:8090` | `SRE_PLATFORM_URL` | HTTP sidecar: `/route`, `/rag/ground` |
| **commander** | `SRE_PLATFORM_ROUTING=true` | Calls platform **before** LLM router (`semantic-platform.ts`) |
| **orchestrator** | `SRE_RAG_GROUNDING=true` | `ragGrounding` node after sanitize, before plan |
| **orchestrator** | `SRE_RAG_LEARNING=true` | Upsert verified fixes to pgvector on `worked: true` |
| **brain** | — | `retrievedPlaybook` injected into `/plan-only` prompt |

### Start for testing

```bash
# Ensure .env.local has OPENROUTER_API_KEY or GEMINI_API_KEY
SRE_AGENT_MODE=agentic ./scripts/compose-up.sh -d

# Wait ~2 min for platform bootstrap (runbook seed)
./scripts/test-platform-integration.sh
```

### Chat test

1. Send: `hello` → semantic **chitchat** (platform) or commander LLM fallback  
2. Send: `investigate OOMKilled in frappe-operator-system frappe-operator-controller-manager`  
3. Watch orchestrator logs for `RAG grounded` and chat for `📚 Runbook grounded`
