"""
Vector-based intent classifier for inbound SRE chat using semantic-router.

Routes:
  - chitchat: greetings, status, non-actionable chatter
  - diagnose: crash/OOM/mount/log analysis questions
  - remediate: patch, restart, deploy, GitOps fix commands
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from semantic_router import Route
from semantic_router.encoders import OpenAIEncoder
from semantic_router.routers import SemanticRouter

from config import get_settings

logger = logging.getLogger(__name__)

RouteIntent = Literal["chitchat", "diagnose", "remediate", "default"]
FALLBACK_INTENT: RouteIntent = "default"

CHITCHAT_UTTERANCES = [
    "hello",
    "hi there",
    "good morning",
    "how are you",
    "what can you do",
    "help me",
    "show status",
    "what is the status of the cluster",
    "list running pods",
    "thanks",
    "thank you",
    "bye",
]

DIAGNOSE_UTTERANCES = [
    "why is my pod crashing",
    "investigate CrashLoopBackOff",
    "analyze OOMKilled container",
    "check mount errors for this deployment",
    "what caused the ImagePullBackOff",
    "show me logs for failing pods",
    "diagnose high restart count",
    "why is the deployment not ready",
    "root cause analysis for this incident",
    "what went wrong with the workload",
    "inspect error events in namespace",
    "debug connection refused errors",
]

REMEDIATE_UTTERANCES = [
    "restart the deployment",
    "patch the image tag",
    "apply gitops fix",
    "run the remediation",
    "fix this by updating the manifest",
    "deploy the hotfix",
    "rollout restart now",
    "push a git patch for this service",
    "execute the runbook fix",
    "remediate the failing workload",
    "update helm values and sync",
    "approve and apply the fix",
]


@dataclass(frozen=True, slots=True)
class RouteOutcome:
    """Structured routing decision consumed by LangGraph entry nodes."""

    intent: RouteIntent
    route_name: str | None
    similarity_score: float
    used_fallback: bool
    raw_utterance: str


def _build_routes() -> list[Route]:
    return [
        Route(name="chitchat", utterances=CHITCHAT_UTTERANCES),
        Route(name="diagnose", utterances=DIAGNOSE_UTTERANCES),
        Route(name="remediate", utterances=REMEDIATE_UTTERANCES),
    ]


def _resolve_openai_key() -> str:
    candidates = [
        os.getenv("OPENROUTER_API_KEY"),
        os.getenv("OPENAI_API_KEY"),
    ]
    settings = get_settings()
    if settings.openrouter_api_key:
        candidates.append(settings.openrouter_api_key.get_secret_value())
    if settings.openai_api_key:
        candidates.append(settings.openai_api_key.get_secret_value())
    for key in candidates:
        if key and str(key).strip():
            return str(key).strip()
    raise RuntimeError(
        "Semantic router requires OPENAI_API_KEY or OPENROUTER_API_KEY "
        "(or set SRE_ROUTER_ENCODER=google with GEMINI_API_KEY)."
    )


def _build_encoder():
    settings = get_settings()
    if settings.router_encoder == "google":
        for import_path in (
            "semantic_router.encoders.google.GoogleEncoder",
            "semantic_router.encoders.GoogleEncoder",
        ):
            try:
                module_path, cls_name = import_path.rsplit(".", 1)
                mod = __import__(module_path, fromlist=[cls_name])
                encoder_cls = getattr(mod, cls_name)
            except (ImportError, AttributeError):
                continue
            api_key = (
                settings.gemini_api_key.get_secret_value()
                if settings.gemini_api_key
                else os.getenv("GEMINI_API_KEY")
            )
            if not api_key:
                logger.warning("GEMINI_API_KEY missing — falling back to OpenAI encoder")
                break
            try:
                os.environ.setdefault("GOOGLE_API_KEY", api_key)
                return encoder_cls(name="text-embedding-004")
            except Exception:
                logger.warning("Google encoder init failed — falling back to OpenAI encoder")

    api_key = _resolve_openai_key()
    base_url = (
        os.getenv("OPENROUTER_BASE_URL")
        or os.getenv("OPENAI_BASE_URL")
        or (
            "https://openrouter.ai/api/v1"
            if os.getenv("OPENROUTER_API_KEY") or get_settings().openrouter_api_key
            else None
        )
    )
    kwargs: dict = {
        "name": "text-embedding-3-small",
        "openai_api_key": api_key,
    }
    if base_url:
        kwargs["openai_base_url"] = base_url
    return OpenAIEncoder(**kwargs)


@lru_cache
def _get_router() -> SemanticRouter:
    encoder = _build_encoder()
    router = SemanticRouter(
        encoder=encoder,
        routes=_build_routes(),
        auto_sync="local",
    )
    return router


def _extract_score(choice) -> float:
    """Best-effort similarity score across semantic-router versions."""
    for attr in ("similarity_score", "score", "similarity"):
        val = getattr(choice, attr, None)
        if isinstance(val, (int, float)):
            return float(val)
    # Some versions expose score only on the first route in similarity_scores
    scores = getattr(choice, "similarity_scores", None)
    if isinstance(scores, dict) and scores:
        return float(max(scores.values()))
    if isinstance(scores, list) and scores:
        return float(max(scores))
    return 0.0


def route_message(text: str) -> RouteOutcome:
    """
    Classify inbound operator text into chitchat | diagnose | remediate.

    If the top route similarity is below SRE_ROUTER_SCORE_THRESHOLD (default 0.70),
    returns intent ``default`` so downstream can apply safe heuristics or LLM fallback.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return RouteOutcome(
            intent=FALLBACK_INTENT,
            route_name=None,
            similarity_score=0.0,
            used_fallback=True,
            raw_utterance=text,
        )

    settings = get_settings()
    threshold = settings.router_score_threshold

    try:
        router = _get_router()
        choice = router(cleaned)
    except Exception:
        logger.exception("Semantic router failed — using fallback intent")
        return RouteOutcome(
            intent=FALLBACK_INTENT,
            route_name=None,
            similarity_score=0.0,
            used_fallback=True,
            raw_utterance=cleaned,
        )

    route_name = getattr(choice, "name", None) or str(choice)
    score = _extract_score(choice)

    if score < threshold or route_name not in ("chitchat", "diagnose", "remediate"):
        logger.info(
            "Router fallback: route=%s score=%.3f threshold=%.3f",
            route_name,
            score,
            threshold,
        )
        return RouteOutcome(
            intent=FALLBACK_INTENT,
            route_name=route_name,
            similarity_score=score,
            used_fallback=True,
            raw_utterance=cleaned,
        )

    intent: RouteIntent = route_name  # type: ignore[assignment]
    logger.debug("Routed intent=%s score=%.3f", intent, score)
    return RouteOutcome(
        intent=intent,
        route_name=route_name,
        similarity_score=score,
        used_fallback=False,
        raw_utterance=cleaned,
    )
