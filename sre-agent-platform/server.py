"""
HTTP sidecar — exposes semantic routing + RAG grounding to TS microservices.
"""

from __future__ import annotations

import logging
import os
import asyncio
import contextlib
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("platform-agent")


class RouteRequest(BaseModel):
    text: str


class RouteResponse(BaseModel):
    intent: str
    route_name: str | None = None
    similarity_score: float = 0.0
    used_fallback: bool = False


class RagGroundRequest(BaseModel):
    detected_error: str = Field(..., min_length=1)
    target_component: str = "compute"
    target_workload: str = ""
    query_text: str = ""


class RagGroundResponse(BaseModel):
    playbook_markdown: str
    error_signature: str
    target_component: str
    similarity: float = 0.0
    found: bool = False


class RagLearnRequest(BaseModel):
    error_signature: str = Field(..., min_length=1)
    target_component: str = "compute"
    playbook_markdown: str = Field(..., min_length=1)
    run_id: str | None = None
    incident_id: str | None = None


class RagLearnResponse(BaseModel):
    upserted: bool
    runbook_id: str | None = None
    proven_count: int = 0
    error_signature: str
    target_component: str


class RagQueryRequest(BaseModel):
    query_text: str = Field(..., min_length=1)
    target_component: str = "compute"
    error_signature: str = ""
    top_k: int = Field(default=3, ge=1, le=10)
    max_chars: int = Field(default=4000, ge=500, le=12000)


class RagQueryHit(BaseModel):
    error_signature: str
    target_component: str
    playbook_markdown: str
    similarity: float = 0.0


class RagQueryResponse(BaseModel):
    hits: list[RagQueryHit] = Field(default_factory=list)
    combined_markdown: str = ""
    found: bool = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    dedup_task = None
    if os.getenv("SRE_RAG_AUTO_MIGRATE", "true").lower() == "true":
        try:
            from scripts.bootstrap_rag import bootstrap

            bootstrap()
        except Exception:
            logger.exception("RAG bootstrap skipped or failed — routing still available")
    if os.getenv("SRE_RAG_DEDUP_ENABLED", "true").lower() in ("1", "true", "yes"):
        try:
            from rag.dedup_worker import run_dedup_loop

            dedup_task = asyncio.create_task(run_dedup_loop())
        except Exception:
            logger.exception("RAG dedup worker failed to start")
    yield
    if dedup_task is not None:
        dedup_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await dedup_task


app = FastAPI(title="SRE Platform Agent", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    from config import get_settings
    from gateway.semantic_router import _get_router  # noqa: PLC2701

    settings = get_settings()
    rag_ok: bool | None = None
    if os.getenv("SRE_RAG_ENABLED", "true").lower() == "true":
        try:
            from rag.pg_vector_store import PgVectorStore

            store = PgVectorStore()
            store.open()
            rag_ok = store.health_check()
            store.close()
        except Exception:
            rag_ok = False

    try:
        _get_router()
        router_ok = True
    except Exception:
        router_ok = False

    return {
        "status": "ok" if router_ok else "degraded",
        "agent": "platform-agent",
        "router_ready": router_ok,
        "rag_db_ready": rag_ok,
        "router_encoder": settings.router_encoder,
        "embedding_provider": settings.embedding_provider,
    }


@app.post("/route", response_model=RouteResponse)
def route(req: RouteRequest) -> RouteResponse:
    from gateway.semantic_router import route_message

    try:
        outcome = route_message(req.text)
    except Exception as exc:
        logger.exception("Route failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return RouteResponse(
        intent=outcome.intent,
        route_name=outcome.route_name,
        similarity_score=outcome.similarity_score,
        used_fallback=outcome.used_fallback,
    )


@app.post("/rag/ground", response_model=RagGroundResponse)
def rag_ground(req: RagGroundRequest) -> RagGroundResponse:
    if os.getenv("SRE_RAG_ENABLED", "true").lower() != "true":
        return RagGroundResponse(
            playbook_markdown="",
            error_signature=req.detected_error,
            target_component=req.target_component,
            found=False,
        )

    from rag.retriever import RunbookRetriever

    try:
        retriever = RunbookRetriever()
        record = retriever.retrieve(
            error_signature=req.detected_error,
            target_component=req.target_component,
            query_text=req.query_text or req.target_workload,
        )
    except Exception as exc:
        logger.exception("RAG ground failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not record:
        return RagGroundResponse(
            playbook_markdown="",
            error_signature=req.detected_error,
            target_component=req.target_component,
            found=False,
        )

    return RagGroundResponse(
        playbook_markdown=record.playbook_markdown,
        error_signature=record.error_signature,
        target_component=record.target_component,
        similarity=record.similarity,
        found=True,
    )


@app.post("/rag/learn", response_model=RagLearnResponse)
def rag_learn(req: RagLearnRequest) -> RagLearnResponse:
    if os.getenv("SRE_RAG_LEARNING", "true").lower() != "true":
        raise HTTPException(status_code=403, detail="RAG learning is disabled")

    from rag.learn import upsert_verified_runbook

    try:
        outcome = upsert_verified_runbook(
            error_signature=req.error_signature,
            target_component=req.target_component,
            playbook_markdown=req.playbook_markdown,
            run_id=req.run_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("RAG learn failed run_id=%s", req.run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    logger.info(
        "RAG learned from run=%s signature=%s proven_count=%s",
        req.run_id,
        outcome.error_signature,
        outcome.proven_count,
    )
    return RagLearnResponse(
        upserted=outcome.upserted,
        runbook_id=outcome.runbook_id,
        proven_count=outcome.proven_count,
        error_signature=outcome.error_signature,
        target_component=outcome.target_component,
    )


@app.post("/rag/query", response_model=RagQueryResponse)
def rag_query(req: RagQueryRequest) -> RagQueryResponse:
    """Top-k runbook retrieval for brain prompt injection (replaces filesystem skills/)."""
    if os.getenv("SRE_RAG_ENABLED", "true").lower() != "true":
        return RagQueryResponse(found=False)

    from rag.retriever import RunbookRetriever

    try:
        retriever = RunbookRetriever()
        hits = retriever.retrieve_many(
            error_signature=req.error_signature or req.query_text,
            target_component=req.target_component,
            query_text=req.query_text,
            top_k=req.top_k,
        )
        # Fallback: CI / gitops playbooks may live under gitops when compute has no hits
        if not hits and req.target_component != "compute":
            hits = retriever.retrieve_many(
                error_signature=req.error_signature or req.query_text,
                target_component="compute",
                query_text=req.query_text,
                top_k=req.top_k,
            )
    except Exception as exc:
        logger.exception("RAG query failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not hits:
        return RagQueryResponse(found=False)

    parts: list[str] = []
    used = 0
    response_hits: list[RagQueryHit] = []
    for h in hits:
        chunk = (
            f"--- {h.error_signature} ({h.target_component}, similarity {h.similarity:.2f}) ---\n"
            f"{h.playbook_markdown.strip()}"
        )
        if used + len(chunk) > req.max_chars:
            break
        parts.append(chunk)
        used += len(chunk) + 2
        response_hits.append(
            RagQueryHit(
                error_signature=h.error_signature,
                target_component=h.target_component,
                playbook_markdown=h.playbook_markdown,
                similarity=h.similarity,
            )
        )

    combined = "\n\n".join(parts)
    return RagQueryResponse(hits=response_hits, combined_markdown=combined, found=bool(combined))


class DeploySourceRegistryRequest(BaseModel):
    namespace: str = Field(..., min_length=1)
    resource_kind: str = Field(..., min_length=1)
    resource_name: str = Field(..., min_length=1)
    playbook_markdown: str = Field(..., min_length=1)
    run_id: str | None = None


class DeploySourceRegistryResponse(BaseModel):
    found: bool = False
    playbook_markdown: str = ""
    error_signature: str = ""


def _deploy_source_key(namespace: str, resource_kind: str, resource_name: str) -> str:
    return f"deploy-source:{namespace}/{resource_kind}/{resource_name}"


@app.get("/registry/deploy-source", response_model=DeploySourceRegistryResponse)
def registry_deploy_source_get(
    namespace: str,
    resource_kind: str,
    resource_name: str,
) -> DeploySourceRegistryResponse:
    if os.getenv("SRE_RAG_ENABLED", "true").lower() != "true":
        return DeploySourceRegistryResponse(found=False)

    from rag.pg_vector_store import PgVectorStore

    key = _deploy_source_key(namespace, resource_kind, resource_name)
    try:
        store = PgVectorStore()
        store.open()
        record = store.get_by_exact_signature(error_signature=key, target_component="gitops")
        store.close()
    except Exception as exc:
        logger.exception("Deploy source registry lookup failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not record:
        return DeploySourceRegistryResponse(found=False, error_signature=key)
    return DeploySourceRegistryResponse(
        found=True,
        playbook_markdown=record.playbook_markdown,
        error_signature=key,
    )


@app.post("/registry/deploy-source", response_model=RagLearnResponse)
def registry_deploy_source_post(req: DeploySourceRegistryRequest) -> RagLearnResponse:
    if os.getenv("SRE_RAG_LEARNING", "true").lower() != "true":
        raise HTTPException(status_code=503, detail="RAG learning disabled")

    from rag.learn import upsert_verified_runbook

    key = _deploy_source_key(req.namespace, req.resource_kind, req.resource_name)
    try:
        outcome = upsert_verified_runbook(
            error_signature=key,
            target_component="gitops",
            playbook_markdown=req.playbook_markdown,
            run_id=req.run_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Deploy source registry upsert failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return RagLearnResponse(
        upserted=outcome.upserted,
        runbook_id=outcome.runbook_id,
        proven_count=outcome.proven_count,
        error_signature=outcome.error_signature,
        target_component=outcome.target_component,
    )
