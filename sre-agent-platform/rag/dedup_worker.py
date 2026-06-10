"""
RAG playbook deduplication — cluster similar runbooks and generalize workload-specific text.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass

from rag.pg_vector_store import PgVectorStore, StoredRunbook
from rag.retriever import EmbeddingClient
from rag.llm_merge import merge_playbooks_with_llm

logger = logging.getLogger(__name__)

_WORKLOAD_LINE = re.compile(
    r"(\*\*Workload:\*\*\s*)([^\n(]+)(\([^)]*\))?", re.IGNORECASE
)
_K8S_PATH = re.compile(
    r"\b(?!application|text|image|multipart|video|audio)[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*\b",
    re.IGNORECASE,
)
_RUN_ID_COMMENT = re.compile(r"<!--\s*ragLearn runId=[^>]+-->", re.IGNORECASE)
_SPECIFIC_DEPLOY = re.compile(
    r"\b(deployments|statefulsets|daemonsets)/[a-z0-9][a-z0-9-]*", re.IGNORECASE
)


@dataclass(frozen=True)
class DedupStats:
    scanned: int = 0
    merged: int = 0
    deleted: int = 0


def _similarity_threshold() -> float:
    raw = os.getenv("SRE_RAG_DEDUP_SIMILARITY", "0.92")
    try:
        return max(0.5, min(0.99, float(raw)))
    except ValueError:
        return 0.92


def parameterize_playbook_markdown(markdown: str) -> str:
    """Strip workload-specific names so playbooks generalize across teams."""
    text = markdown
    text = _RUN_ID_COMMENT.sub("", text)
    text = _WORKLOAD_LINE.sub(r"\1{workload} ({namespace})", text)
    text = _K8S_PATH.sub("{namespace}/{workload}", text)
    text = _SPECIFIC_DEPLOY.sub("deployments/{workload}", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _merge_markdown(canonical: str, duplicate: str) -> str:
    llm_merged = merge_playbooks_with_llm(canonical, duplicate)
    if llm_merged:
        return parameterize_playbook_markdown(llm_merged)

    canon_lines = [ln for ln in canonical.splitlines() if ln.strip()]
    dupe_lines = [ln for ln in duplicate.splitlines() if ln.strip()]
    merged: list[str] = []
    seen = set()
    for ln in canon_lines + dupe_lines:
        key = ln.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(ln)
    body = "\n".join(merged)
    return parameterize_playbook_markdown(body)


def deduplicate_runbooks(
    *,
    store: PgVectorStore | None = None,
    embedder: EmbeddingClient | None = None,
    similarity_threshold: float | None = None,
) -> DedupStats:
    threshold = similarity_threshold if similarity_threshold is not None else _similarity_threshold()
    owned = store is None
    db = store or PgVectorStore()
    if owned:
        db.open()

    emb = embedder or EmbeddingClient()
    stats = DedupStats()
    deleted_ids: set[str] = set()

    try:
        all_rows = db.list_all_runbooks()
        stats = DedupStats(scanned=len(all_rows))

        by_component: dict[str, list[StoredRunbook]] = {}
        for row in all_rows:
            by_component.setdefault(row.target_component, []).append(row)

        for component, rows in by_component.items():
            for i, primary in enumerate(rows):
                if primary.id in deleted_ids:
                    continue
                for secondary in rows[i + 1 :]:
                    if secondary.id in deleted_ids:
                        continue
                    if primary.error_signature == secondary.error_signature:
                        continue

                    sim = db.cosine_similarity(primary.embedding, secondary.embedding)
                    if sim < threshold:
                        continue

                    merged_md = _merge_markdown(
                        primary.playbook_markdown,
                        secondary.playbook_markdown,
                    )
                    merged_md = parameterize_playbook_markdown(merged_md)
                    proven = max(primary.proven_count, secondary.proven_count) + 1
                    vector = emb.embed(f"{primary.error_signature} {merged_md[:400]}")

                    db.update_runbook(
                        runbook_id=primary.id,
                        playbook_markdown=merged_md,
                        embedding=vector,
                        proven_count=proven,
                    )
                    db.delete_runbook(secondary.id)
                    deleted_ids.add(secondary.id)
                    stats = DedupStats(
                        scanned=stats.scanned,
                        merged=stats.merged + 1,
                        deleted=stats.deleted + 1,
                    )
                    logger.info(
                        "RAG dedup merged id=%s <- %s component=%s similarity=%.3f",
                        primary.id,
                        secondary.id,
                        component,
                        sim,
                    )
    finally:
        if owned:
            db.close()

    return stats


async def run_dedup_loop() -> None:
    interval = int(os.getenv("SRE_RAG_DEDUP_INTERVAL_SEC", "3600"))
    if interval <= 0:
        return
    enabled = os.getenv("SRE_RAG_DEDUP_ENABLED", "true").lower() in ("1", "true", "yes")
    if not enabled:
        logger.info("RAG dedup worker disabled (SRE_RAG_DEDUP_ENABLED=false)")
        return

    logger.info("RAG dedup worker started interval=%ss threshold=%s", interval, _similarity_threshold())
    while True:
        try:
            stats = await asyncio.to_thread(deduplicate_runbooks)
            if stats.merged:
                logger.info(
                    "RAG dedup cycle complete scanned=%s merged=%s deleted=%s",
                    stats.scanned,
                    stats.merged,
                    stats.deleted,
                )
        except Exception:
            logger.exception("RAG dedup cycle failed")
        await asyncio.sleep(interval)
