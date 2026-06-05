"""
Upsert verified remediation playbooks into pgvector (learning loop).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from pgvector.psycopg import register_vector

from config import get_settings
from rag.pg_vector_store import PgVectorStore
from rag.retriever import EmbeddingClient

logger = logging.getLogger(__name__)

_VALID_COMPONENTS = frozenset(
    {"compute", "storage", "network", "gitops", "database", "security"}
)
_IDENT_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


@dataclass(frozen=True, slots=True)
class LearnOutcome:
    upserted: bool
    runbook_id: str | None
    proven_count: int
    error_signature: str
    target_component: str


def _normalize_component(component: str) -> str:
    c = (component or "compute").strip().lower()
    return c if c in _VALID_COMPONENTS else "compute"


def upsert_verified_runbook(
    *,
    error_signature: str,
    target_component: str,
    playbook_markdown: str,
    run_id: str | None = None,
    store: PgVectorStore | None = None,
    embedder: EmbeddingClient | None = None,
) -> LearnOutcome:
    """
    Insert or update a runbook row keyed by (error_signature, target_component).

    Embeds ``error_signature + playbook excerpt`` — same convention as bootstrap seed.
    """
    signature = (error_signature or "").strip()
    markdown = (playbook_markdown or "").strip()
    component = _normalize_component(target_component)

    if not signature:
        raise ValueError("error_signature is required")
    if not markdown:
        raise ValueError("playbook_markdown is required")

    settings = get_settings()
    table = _IDENT_RE.match(settings.rag_table or "sre_runbooks")
    if not table:
        raise ValueError("Invalid RAG table name")
    table_name = settings.rag_table

    owned_store = store is None
    db = store or PgVectorStore()
    if owned_store:
        db.open()

    emb = embedder or EmbeddingClient()
    embed_text = f"{signature} {markdown[:400]}"
    vector = emb.embed(embed_text)

    try:
        with db._connection() as conn:  # noqa: SLF001
            register_vector(conn)
            row = conn.execute(
                f"""
                INSERT INTO {table_name}
                    (error_signature, target_component, playbook_markdown, embedding,
                     source_run_id, proven_count, updated_at)
                VALUES (%s, %s, %s, %s, %s, 1, now())
                ON CONFLICT (error_signature, target_component)
                DO UPDATE SET
                    playbook_markdown = EXCLUDED.playbook_markdown,
                    embedding = EXCLUDED.embedding,
                    source_run_id = EXCLUDED.source_run_id,
                    proven_count = {table_name}.proven_count + 1,
                    updated_at = now()
                RETURNING id::text, proven_count
                """,
                (signature, component, markdown, vector, run_id),
            ).fetchone()
    finally:
        if owned_store:
            db.close()

    if not row:
        return LearnOutcome(
            upserted=False,
            runbook_id=None,
            proven_count=0,
            error_signature=signature,
            target_component=component,
        )

    logger.info(
        "RAG learn upserted signature=%s component=%s proven_count=%s run_id=%s",
        signature,
        component,
        row["proven_count"],
        run_id,
    )
    return LearnOutcome(
        upserted=True,
        runbook_id=str(row["id"]),
        proven_count=int(row["proven_count"]),
        error_signature=signature,
        target_component=component,
    )
