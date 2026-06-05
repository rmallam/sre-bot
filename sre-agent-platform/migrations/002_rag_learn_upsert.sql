-- Learning loop: upsert verified fixes by (error_signature, target_component)

ALTER TABLE sre_runbooks
    ADD COLUMN IF NOT EXISTS source_run_id TEXT,
    ADD COLUMN IF NOT EXISTS proven_count INT NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS sre_runbooks_sig_component_uidx
    ON sre_runbooks (error_signature, target_component);

COMMENT ON COLUMN sre_runbooks.source_run_id IS
    'Orchestrator runId that last verified this playbook';
COMMENT ON COLUMN sre_runbooks.proven_count IS
    'Number of successful remediations that confirmed this playbook';
