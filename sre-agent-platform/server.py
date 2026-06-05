"""
HTTP sidecar — exposes semantic routing + RAG grounding to TS microservices.
"""

from __future__ import annotations

import logging
import os
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("SRE_RAG_AUTO_MIGRATE", "true").lower() == "true":
        try:
            from scripts.bootstrap_rag import bootstrap

            bootstrap()
        except Exception:
            logger.exception("RAG bootstrap skipped or failed — routing still available")
    yield


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
