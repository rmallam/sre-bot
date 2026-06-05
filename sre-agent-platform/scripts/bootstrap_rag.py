#!/usr/bin/env python3
"""Apply migrations and seed sample runbooks when RAG DB is empty."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("bootstrap_rag")

SAMPLE_RUNBOOKS: list[dict] = [
    {
        "error_signature": "OOMKilled",
        "target_component": "compute",
        "playbook_markdown": """# OOMKilled Runbook

1. Confirm container exit reason is OOMKilled via `kubectl describe pod`.
2. Compare memory limits vs working set in metrics.
3. Remediation order:
   - Increase memory limits in deployment manifest (git_patch).
   - If transient spike, rollout restart after limit bump.
4. Verify: pod Running, restart count stable, no OOM events in 5m.
5. Rollback: revert manifest commit if latency/regression detected.
""",
    },
    {
        "error_signature": "ImagePullBackOff",
        "target_component": "gitops",
        "playbook_markdown": """# ImagePullBackOff Runbook

1. Verify image tag exists in registry (`crane digest` or registry UI).
2. Check imagePullSecrets on ServiceAccount.
3. Remediation:
   - git_patch: correct image repository/tag in deployment.
   - If operator supplies alternate registry, apply that tag.
4. Verify: pod reaches Running, no ErrImagePull events.
""",
    },
    {
        "error_signature": "CrashLoopBackOff",
        "target_component": "compute",
        "playbook_markdown": """# CrashLoopBackOff Runbook

1. Fetch current and previous container logs.
2. Classify: config error vs dependency vs probe failure.
3. Remediation order:
   - restart once if no prior restart_failed in action history.
   - git_patch for config/env fixes.
   - escalate_human if logs show unrecoverable app bug.
4. Verify: readiness probe passing, restart count stable.
""",
    },
]


def _expected_vector_type(dimensions: int) -> str:
    return f"vector({dimensions})"


def _ensure_runbook_schema(store, settings) -> None:
    """Recreate empty runbook table when embedding dimensions drift (e.g. 768 → 1536)."""
    table = store._table  # noqa: SLF001
    expected = _expected_vector_type(settings.embedding_dimensions)
    with store._connection() as conn:  # noqa: SLF001
        row = conn.execute(
            """
            SELECT format_type(a.atttypid, a.atttypmod) AS coltype
            FROM pg_attribute a
            JOIN pg_class c ON a.attrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = 'public'
              AND c.relname = %s
              AND a.attname = 'embedding'
              AND NOT a.attisdropped
            """,
            (table,),
        ).fetchone()
        if row and row["coltype"] == expected:
            return
        if row and row["coltype"] != expected:
            count = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
            if int(count) > 0:
                raise RuntimeError(
                    f"Runbook table {table} uses {row['coltype']} but "
                    f"{expected} is configured — migrate or truncate manually"
                )
            logger.warning(
                "Dropping empty %s (was %s, need %s)",
                table,
                row["coltype"],
                expected,
            )
            conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")


def bootstrap() -> None:
    from config import get_settings
    from rag.pg_vector_store import PgVectorStore
    from rag.retriever import EmbeddingClient

    settings = get_settings()
    store = PgVectorStore()
    store.open()

    migration_path = os.path.join(
        os.path.dirname(__file__), "..", "migrations", "001_sre_runbooks.sql"
    )
    learn_migration = os.path.join(
        os.path.dirname(__file__), "..", "migrations", "002_rag_learn_upsert.sql"
    )
    if os.path.isfile(migration_path):
        _ensure_runbook_schema(store, settings)
        with open(migration_path, encoding="utf-8") as f:
            sql = f.read()
        with store._connection() as conn:  # noqa: SLF001
            conn.execute(sql)
    if os.path.isfile(learn_migration):
        with open(learn_migration, encoding="utf-8") as f:
            sql = f.read()
        with store._connection() as conn:  # noqa: SLF001
            conn.execute(sql)

    with store._connection() as conn:  # noqa: SLF001
        count = conn.execute(
            f"SELECT COUNT(*) AS c FROM {store._table}"  # noqa: SLF001
        ).fetchone()["c"]

    if count and int(count) > 0:
        logger.info("RAG runbooks already seeded (%s rows)", count)
        store.close()
        return

    embedder = EmbeddingClient()
    table = store._table  # noqa: SLF001
    from pgvector.psycopg import register_vector

    for row in SAMPLE_RUNBOOKS:
        text = f"{row['error_signature']} {row['playbook_markdown'][:200]}"
        vector = embedder.embed(text)
        with store._connection() as conn:  # noqa: SLF001
            register_vector(conn)
            conn.execute(
                f"""
                INSERT INTO {table}
                    (error_signature, target_component, playbook_markdown, embedding)
                VALUES (%s, %s, %s, %s)
                """,
                (
                    row["error_signature"],
                    row["target_component"],
                    row["playbook_markdown"],
                    vector,
                ),
            )
        logger.info("Seeded runbook %s/%s", row["target_component"], row["error_signature"])

    store.close()
    logger.info("RAG bootstrap complete")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    bootstrap()
