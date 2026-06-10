"""
EDB Postgres (CloudNativePG) pgvector connection and hybrid runbook search.

Hybrid search = strict metadata filter on ``target_component`` + cosine distance
ordering on the embedding column. Prevents cross-domain playbook hallucination.
"""

from __future__ import annotations

import logging
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Sequence

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from config import get_settings

logger = logging.getLogger(__name__)

# Table/column identifiers are validated — never interpolate user input here.
_IDENT_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


def _validate_ident(name: str) -> str:
    if not _IDENT_RE.match(name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    return name


@dataclass(frozen=True, slots=True)
class RunbookRecord:
    """Single runbook snippet returned from hybrid vector search."""

    id: str
    error_signature: str
    target_component: str
    playbook_markdown: str
    similarity: float


@dataclass(frozen=True, slots=True)
class StoredRunbook:
    """Full runbook row for dedup / maintenance."""

    id: str
    error_signature: str
    target_component: str
    playbook_markdown: str
    embedding: list[float]
    proven_count: int


class PgVectorStore:
    """
    Connection pool to external EDB Postgres with pgvector enabled.

    Expected schema (adjust via migration in ops repo):

    ```sql
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE sre_runbooks (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        error_signature TEXT NOT NULL,
        target_component TEXT NOT NULL,
        playbook_markdown TEXT NOT NULL,
        embedding       vector(1536) NOT NULL,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX sre_runbooks_component_idx ON sre_runbooks (target_component);
    CREATE INDEX sre_runbooks_embedding_idx ON sre_runbooks
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    ```
    """

    def __init__(
        self,
        database_url: str | None = None,
        table: str | None = None,
        *,
        min_size: int | None = None,
        max_size: int | None = None,
    ) -> None:
        settings = get_settings()
        self._database_url = database_url or settings.rag_database_url
        self._table = _validate_ident(table or settings.rag_table)
        self._pool = ConnectionPool(
            conninfo=self._database_url,
            min_size=min_size or settings.rag_pool_min,
            max_size=max_size or settings.rag_pool_max,
            kwargs={"row_factory": dict_row, "autocommit": True},
            open=False,
        )

    def open(self) -> None:
        self._pool.open()
        with self._connection() as conn:
            conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            register_vector(conn)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def _connection(self) -> Iterator[psycopg.Connection]:
        with self._pool.connection() as conn:
            yield conn

    def hybrid_search(
        self,
        *,
        error_signature: str,
        target_component: str,
        query_embedding: Sequence[float],
        top_k: int = 1,
    ) -> list[RunbookRecord]:
        """
        Optimized hybrid search:
          1. ``WHERE target_component = %s`` — strict metadata gate
          2. ``ORDER BY embedding <=> %s`` — cosine distance (pgvector)
          3. Optional ``error_signature`` ILIKE boost in SELECT ranking

        Parameters are fully parameterized; no string concatenation of user values.
        """
        if not query_embedding:
            raise ValueError("query_embedding must be non-empty")
        if top_k < 1:
            raise ValueError("top_k must be >= 1")

        component = (target_component or "").strip()
        if not component:
            raise ValueError("target_component is required for hybrid search")

        signature = (error_signature or "").strip()
        table = self._table

        # Cosine distance operator <=>; similarity = 1 - distance
        sql = f"""
            SELECT
                id::text AS id,
                error_signature,
                target_component,
                playbook_markdown,
                (1 - (embedding <=> %(embedding)s::vector)) AS similarity
            FROM {table}
            WHERE target_component = %(target_component)s
            ORDER BY
                CASE
                    WHEN %(error_signature)s <> ''
                         AND error_signature ILIKE '%%' || %(error_signature)s || '%%'
                    THEN 0
                    ELSE 1
                END,
                embedding <=> %(embedding)s::vector
            LIMIT %(top_k)s
        """

        params: dict[str, Any] = {
            "embedding": list(query_embedding),
            "target_component": component,
            "error_signature": signature,
            "top_k": top_k,
        }

        try:
            with self._connection() as conn:
                register_vector(conn)
                rows = conn.execute(sql, params).fetchall()
        except psycopg.Error:
            logger.exception(
                "Hybrid runbook search failed component=%s signature=%s",
                component,
                signature,
            )
            raise

        return [
            RunbookRecord(
                id=str(row["id"]),
                error_signature=str(row["error_signature"]),
                target_component=str(row["target_component"]),
                playbook_markdown=str(row["playbook_markdown"]),
                similarity=float(row["similarity"] or 0.0),
            )
            for row in rows
        ]

    def get_by_exact_signature(
        self,
        *,
        error_signature: str,
        target_component: str = "gitops",
    ) -> RunbookRecord | None:
        """Exact lookup for deploy-source registry keys."""
        signature = (error_signature or "").strip()
        component = (target_component or "gitops").strip()
        if not signature:
            return None

        table = self._table
        sql = f"""
            SELECT
                id::text AS id,
                error_signature,
                target_component,
                playbook_markdown,
                1.0 AS similarity
            FROM {table}
            WHERE error_signature = %(error_signature)s
              AND target_component = %(target_component)s
            LIMIT 1
        """
        try:
            with self._connection() as conn:
                row = conn.execute(
                    sql,
                    {"error_signature": signature, "target_component": component},
                ).fetchone()
        except psycopg.Error:
            logger.exception(
                "Exact runbook lookup failed signature=%s", signature
            )
            raise

        if not row:
            return None
        return RunbookRecord(
            id=str(row["id"]),
            error_signature=str(row["error_signature"]),
            target_component=str(row["target_component"]),
            playbook_markdown=str(row["playbook_markdown"]),
            similarity=1.0,
        )

    def health_check(self) -> bool:
        try:
            with self._connection() as conn:
                conn.execute("SELECT 1").fetchone()
            return True
        except psycopg.Error:
            logger.exception("RAG database health check failed")
            return False

    def list_all_runbooks(self) -> list[StoredRunbook]:
        table = self._table
        sql = f"""
            SELECT
                id::text AS id,
                error_signature,
                target_component,
                playbook_markdown,
                embedding,
                COALESCE(proven_count, 1) AS proven_count
            FROM {table}
            ORDER BY target_component, error_signature
        """
        with self._connection() as conn:
            register_vector(conn)
            rows = conn.execute(sql).fetchall()
        out: list[StoredRunbook] = []
        for row in rows:
            emb = row["embedding"]
            out.append(
                StoredRunbook(
                    id=str(row["id"]),
                    error_signature=str(row["error_signature"]),
                    target_component=str(row["target_component"]),
                    playbook_markdown=str(row["playbook_markdown"]),
                    embedding=list(emb) if emb is not None else [],
                    proven_count=int(row["proven_count"] or 1),
                )
            )
        return out

    @staticmethod
    def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b, strict=True))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    def update_runbook(
        self,
        *,
        runbook_id: str,
        playbook_markdown: str,
        embedding: Sequence[float],
        proven_count: int,
    ) -> None:
        table = self._table
        sql = f"""
            UPDATE {table}
            SET playbook_markdown = %(markdown)s,
                embedding = %(embedding)s::vector,
                proven_count = %(proven_count)s,
                updated_at = now()
            WHERE id = %(id)s::uuid
        """
        with self._connection() as conn:
            register_vector(conn)
            conn.execute(
                sql,
                {
                    "id": runbook_id,
                    "markdown": playbook_markdown,
                    "embedding": list(embedding),
                    "proven_count": proven_count,
                },
            )

    def delete_runbook(self, runbook_id: str) -> None:
        table = self._table
        with self._connection() as conn:
            conn.execute(
                f"DELETE FROM {table} WHERE id = %(id)s::uuid",
                {"id": runbook_id},
            )
