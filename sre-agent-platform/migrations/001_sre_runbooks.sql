-- EDB Postgres (CloudNativePG) + pgvector schema for SRE runbook RAG
-- Apply against your external RAG instance (not the orchestrator run-store DB).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sre_runbooks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    error_signature   TEXT NOT NULL,
    target_component  TEXT NOT NULL CHECK (target_component IN (
        'compute', 'storage', 'network', 'gitops', 'database', 'security'
    )),
    playbook_markdown TEXT NOT NULL,
    embedding         vector(1536) NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sre_runbooks_component_idx
    ON sre_runbooks (target_component);

CREATE INDEX IF NOT EXISTS sre_runbooks_signature_idx
    ON sre_runbooks (error_signature);

-- IVFFlat index — build after seeding data (lists ~= sqrt(rowcount))
CREATE INDEX IF NOT EXISTS sre_runbooks_embedding_cosine_idx
    ON sre_runbooks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE sre_runbooks IS
    'Official K8s SRE runbook snippets for hybrid vector + metadata RAG retrieval';
