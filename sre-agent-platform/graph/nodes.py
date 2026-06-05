"""
LangGraph node functions — semantic routing, RAG grounding, planning context.

Topology injection point:
  ... → investigative_gather → **rag_grounding_node** → plan → act → verify
"""

from __future__ import annotations

import logging
import re
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from config import get_settings
from gateway.semantic_router import route_message
from graph.state import SREAgentState
from rag.retriever import RunbookRetriever

logger = logging.getLogger(__name__)

# Common Kubernetes error signatures for auto-detection from messages/events
_ERROR_SIGNATURES: tuple[str, ...] = (
    "CrashLoopBackOff",
    "OOMKilled",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "RunContainerError",
    "FailedMount",
    "FailedScheduling",
    "Evicted",
    "ContainerCannotRun",
    "DeadlineExceeded",
    "ConnectionRefused",
    "BackOff",
)

_COMPONENT_HINTS: dict[str, tuple[str, ...]] = {
    "storage": ("FailedMount", "PersistentVolume", "volume", "PVC", "mount"),
    "network": ("ConnectionRefused", "timeout", "DNS", "ingress", "service"),
    "gitops": ("ImagePullBackOff", "ErrImagePull", "git", "helm", "argocd"),
    "compute": ("OOMKilled", "CrashLoopBackOff", "CPU", "memory", "Evicted"),
}


def _latest_human_text(state: SREAgentState) -> str:
    for msg in reversed(state.get("messages") or []):
        if isinstance(msg, HumanMessage):
            return str(msg.content)
        if getattr(msg, "type", None) == "human":
            return str(msg.content)
    return ""


def _infer_error_signature(text: str, existing: str) -> str:
    if existing:
        return existing
    upper = text.upper()
    for sig in _ERROR_SIGNATURES:
        if sig.upper() in upper or sig.lower() in text.lower():
            return sig
    # Regex for exit codes / OOM patterns
    if re.search(r"\boom\b", text, re.I):
        return "OOMKilled"
    if re.search(r"exit code [1-9]", text, re.I):
        return "CrashLoopBackOff"
    return ""


def _infer_target_component(text: str, error: str, existing: str) -> str:
    if existing and existing != "compute":
        return existing
    blob = f"{text} {error}".lower()
    for component, hints in _COMPONENT_HINTS.items():
        if any(h.lower() in blob for h in hints):
            return component
    return existing or "compute"


def semantic_route_node(state: SREAgentState) -> dict:
    """
    Entry node: classify operator intent via semantic-router gateway.

    Populates ``route_intent`` and ``route_score`` for downstream branching.
    """
    text = _latest_human_text(state)
    outcome = route_message(text)

    updates: dict = {
        "route_intent": outcome.intent,
        "route_score": outcome.similarity_score,
    }

    # Seed investigation fields when diagnose/remediate
    if outcome.intent in ("diagnose", "remediate", "default"):
        error = _infer_error_signature(text, state.get("detected_error", ""))
        component = _infer_target_component(
            text,
            error,
            state.get("target_component", "compute"),
        )
        if error:
            updates["detected_error"] = error
        updates["target_component"] = component

    logger.info(
        "semantic_route intent=%s score=%.3f fallback=%s",
        outcome.intent,
        outcome.similarity_score,
        outcome.used_fallback,
    )
    return updates


def rag_grounding_node(state: SREAgentState) -> dict:
    """
    RAG grounding node — runs AFTER investigative gathering, BEFORE planning.

    1. Embed ``detected_error`` (plus message context)
    2. Hybrid pgvector search with strict ``target_component`` filter
    3. Store markdown playbook in ``retrieved_playbook``
    """
    error = (state.get("detected_error") or "").strip()
    component = (state.get("target_component") or "compute").strip()
    query_text = _latest_human_text(state)

    if not error:
        logger.warning("rag_grounding_node: no detected_error — skipping RAG")
        return {
            "retrieved_playbook": "",
            "messages": [
                SystemMessage(
                    content="RAG grounding skipped: no error signature detected yet."
                )
            ],
        }

    retriever = RunbookRetriever()
    markdown = retriever.retrieve_markdown(
        error_signature=error,
        target_component=component,
        query_text=query_text,
    )

    if markdown:
        summary = (
            f"Grounded runbook retrieved for `{error}` "
            f"(component={component}, {len(markdown)} chars)."
        )
    else:
        summary = (
            f"No official runbook found for `{error}` in component `{component}`. "
            "Planner must proceed with low confidence and prefer HIL."
        )

    logger.info("rag_grounding %s", summary)
    return {
        "retrieved_playbook": markdown,
        "messages": [SystemMessage(content=summary)],
    }


def build_planning_prompt(state: SREAgentState) -> str:
    """
    Build LLM planner system prompt with mandatory runbook grounding.

    All remediation choices (restart, patch, gitops) must cite retrieved_playbook.
    """
    playbook = (state.get("retrieved_playbook") or "").strip()
    error = state.get("detected_error") or "unknown"
    workload = state.get("target_workload") or "unspecified"
    intent = state.get("route_intent") or "default"

    playbook_block = (
        playbook
        if playbook
        else "⚠️ NO OFFICIAL RUNBOOK RETRIEVED — require human approval before writes."
    )

    return f"""You are an enterprise SRE remediation planner for Kubernetes.

Operator intent: {intent}
Detected error signature: {error}
Target workload: {workload}

## OFFICIAL RUNBOOK (mandatory grounding)
You MUST align every proposed action with the following runbook.
Do NOT invent steps not supported by this document.
If the runbook is empty, propose only read-only investigation or escalate.

{playbook_block}

## Output
Return a concise remediation plan listing:
1. Root cause hypothesis (grounded in runbook)
2. Ordered actions (restart | patch | gitops) with tool names
3. Verification steps
4. Rollback note
"""


def plan_with_playbook_node(state: SREAgentState) -> dict:
    """
    Planning node stub — attaches grounded prompt for downstream LLM call.

    In production, wire this to your brain-agent HTTP client or LangChain chat model.
    """
    prompt = build_planning_prompt(state)
    # Placeholder: real deployment calls brain /plan-capability with this context
    plan_summary = (
        f"Plan context prepared for {state.get('detected_error', 'unknown')} "
        f"on {state.get('target_workload') or 'workload'} "
        f"(playbook {'present' if state.get('retrieved_playbook') else 'missing'})."
    )
    return {
        "remediation_plan": prompt,
        "messages": [AIMessage(content=plan_summary)],
    }


def increment_verification_node(state: SREAgentState) -> dict:
    """Track verify/retry loops to prevent infinite self-correction."""
    attempts = int(state.get("verification_attempts") or 0) + 1
    settings = get_settings()
    return {
        "verification_attempts": attempts,
        "messages": [
            SystemMessage(
                content=f"Verification attempt {attempts}/{settings.max_verification_attempts}"
            )
        ],
    }


def should_continue_verification(state: SREAgentState) -> Literal["retry", "escalate", "done"]:
    """
    Conditional edge after verify node.

    Returns:
      - ``retry`` — re-enter investigation / RAG grounding
      - ``escalate`` — HIL / human handoff
      - ``done`` — terminal success
    """
    settings = get_settings()
    attempts = int(state.get("verification_attempts") or 0)
    status = (state.get("execution_status") or "").lower()

    if status in ("succeeded", "healthy", "ok"):
        return "done"
    if attempts >= settings.max_verification_attempts:
        return "escalate"
    return "retry"
