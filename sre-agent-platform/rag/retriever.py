"""
Runbook retriever — embeds error signatures and queries pgvector hybrid search.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Sequence

from config import get_settings
from rag.pg_vector_store import PgVectorStore, RunbookRecord

logger = logging.getLogger(__name__)


class EmbeddingClient:
    """Thin wrapper over OpenAI or Google embedding APIs."""

    def __init__(self) -> None:
        self._settings = get_settings()

    def embed(self, text: str) -> list[float]:
        cleaned = (text or "").strip()
        if not cleaned:
            raise ValueError("Cannot embed empty text")

        if self._settings.embedding_provider == "google":
            try:
                return self._embed_google(cleaned)
            except Exception:
                logger.warning("Google embedding failed — falling back to OpenAI")
        return self._embed_openai(cleaned)

    def _embed_openai(self, text: str) -> list[float]:
        try:
            from langchain_openai import OpenAIEmbeddings
        except ImportError as exc:
            raise RuntimeError("Install langchain-openai for OpenAI embeddings") from exc

        settings = self._settings
        api_key = (
            os.getenv("OPENROUTER_API_KEY")
            or os.getenv("OPENAI_API_KEY")
            or (settings.openrouter_api_key.get_secret_value() if settings.openrouter_api_key else None)
            or (settings.openai_api_key.get_secret_value() if settings.openai_api_key else None)
        )
        if not api_key or not str(api_key).strip():
            raise RuntimeError("OPENROUTER_API_KEY or OPENAI_API_KEY required for embeddings")

        base_url = os.getenv("OPENROUTER_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        kwargs: dict = {
            "model": settings.embedding_model_openai,
            "api_key": str(api_key).strip(),
        }
        if base_url:
            kwargs["base_url"] = base_url

        client = OpenAIEmbeddings(**kwargs)
        vector = client.embed_query(text)
        return list(vector)

    def _embed_google(self, text: str) -> list[float]:
        try:
            from langchain_google_genai import GoogleGenerativeAIEmbeddings
        except ImportError as exc:
            raise RuntimeError("Install langchain-google-genai for Google embeddings") from exc

        settings = self._settings
        api_key = (
            settings.gemini_api_key.get_secret_value()
            if settings.gemini_api_key
            else os.getenv("GEMINI_API_KEY")
        )
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY required for Google embeddings")

        client = GoogleGenerativeAIEmbeddings(
            model=settings.embedding_model_google,
            google_api_key=api_key,
        )
        vector = client.embed_query(text)
        return list(vector)


@lru_cache
def _default_store() -> PgVectorStore:
    store = PgVectorStore()
    store.open()
    return store


@lru_cache
def _default_embedder() -> EmbeddingClient:
    return EmbeddingClient()


class RunbookRetriever:
    """
    High-level RAG API used by ``rag_grounding_node``.

    Accepts error signature + target component, embeds the signature (or full query),
    and returns the top matching official playbook markdown snippet.
    """

    def __init__(
        self,
        store: PgVectorStore | None = None,
        embedder: EmbeddingClient | None = None,
    ) -> None:
        self._store = store or _default_store()
        self._embedder = embedder or _default_embedder()

    def retrieve_many(
        self,
        *,
        error_signature: str,
        target_component: str,
        query_text: str | None = None,
        top_k: int = 3,
    ) -> list[RunbookRecord]:
        """Return top-k runbooks for brain prompt injection."""
        embed_source = " ".join(
            part
            for part in (
                (error_signature or "").strip(),
                (query_text or "").strip(),
            )
            if part
        )
        if not embed_source:
            return []

        try:
            embedding = self._embedder.embed(embed_source)
        except Exception:
            logger.exception("Embedding failed for query=%s", embed_source[:80])
            return []

        try:
            return self._store.hybrid_search(
                error_signature=error_signature,
                target_component=target_component,
                query_embedding=embedding,
                top_k=top_k,
            )
        except Exception:
            logger.exception(
                "Runbook search failed component=%s signature=%s",
                target_component,
                error_signature,
            )
            return []

    def retrieve(
        self,
        *,
        error_signature: str,
        target_component: str,
        query_text: str | None = None,
        top_k: int = 1,
    ) -> RunbookRecord | None:
        """
        Hybrid search pipeline:
          1. Build embedding text from signature + optional query context
          2. Strict ``target_component`` SQL filter
          3. Cosine distance ranking
        """
        embed_source = " ".join(
            part
            for part in (
                (error_signature or "").strip(),
                (query_text or "").strip(),
            )
            if part
        )
        if not embed_source:
            logger.warning("Retriever called with empty signature and query")
            return None

        try:
            embedding = self._embedder.embed(embed_source)
        except Exception:
            logger.exception("Embedding failed for signature=%s", error_signature)
            return None

        try:
            hits = self._store.hybrid_search(
                error_signature=error_signature,
                target_component=target_component,
                query_embedding=embedding,
                top_k=top_k,
            )
        except Exception:
            logger.exception(
                "Runbook hybrid search failed component=%s signature=%s",
                target_component,
                error_signature,
            )
            return None

        if not hits:
            logger.info(
                "No runbook hit component=%s signature=%s",
                target_component,
                error_signature,
            )
            return None

        best = hits[0]
        logger.info(
            "Runbook retrieved id=%s similarity=%.3f component=%s",
            best.id,
            best.similarity,
            best.target_component,
        )
        return best

    def retrieve_markdown(
        self,
        *,
        error_signature: str,
        target_component: str,
        query_text: str | None = None,
    ) -> str:
        """Convenience wrapper returning markdown or empty string."""
        record = self.retrieve(
            error_signature=error_signature,
            target_component=target_component,
            query_text=query_text,
        )
        return record.playbook_markdown if record else ""
