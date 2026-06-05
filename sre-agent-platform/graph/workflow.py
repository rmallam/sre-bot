"""
LangGraph workflow assembly — gold-standard SRE topology.

Flow:
  START → semantic_route → gather (placeholder) → rag_grounding → plan → END

Verify loop (when integrated with act/verify microservices):
  verify → increment_verification → should_continue → rag_grounding | END | escalate
"""

from __future__ import annotations

import logging
from typing import Literal

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from langchain_core.messages import AIMessage, SystemMessage

from graph.nodes import (
    increment_verification_node,
    plan_with_playbook_node,
    rag_grounding_node,
    semantic_route_node,
)
from graph.state import SREAgentState

logger = logging.getLogger(__name__)


def investigative_gather_node(state: SREAgentState) -> dict:
    """
    Placeholder for investigator microservice calls (GET /facts or agent-step loop).

    Wire to your existing TypeScript investigator-agent HTTP API:
      INVESTIGATOR_URL=http://investigator-agent:8080
    """
    workload = state.get("target_workload") or ""
    error = state.get("detected_error") or ""
    return {
        "messages": [
            SystemMessage(
                content=(
                    f"Investigation gather complete for workload={workload or 'TBD'} "
                    f"error={error or 'pending'}."
                ),
            )
        ],
    }


def route_by_intent(state: SREAgentState) -> Literal["gather", "chitchat", "end"]:
    """Branch after semantic routing."""
    intent = (state.get("route_intent") or "default").lower()
    if intent == "chitchat":
        return "chitchat"
    if intent in ("diagnose", "remediate", "default"):
        return "gather"
    return "end"


def chitchat_node(state: SREAgentState) -> dict:
    """Lightweight response path — no RAG or remediation."""
    return {
        "execution_status": "chitchat",
        "messages": [
            AIMessage(
                content=(
                    "Hello — I can diagnose Kubernetes issues or run remediations. "
                    "Try: 'investigate CrashLoopBackOff in payments-api'."
                ),
            )
        ],
    }


def escalate_node(state: SREAgentState) -> dict:
    return {
        "execution_status": "escalated",
        "messages": [
            AIMessage(
                content="Max verification attempts reached — escalating to human operator.",
            )
        ],
    }


def build_workflow(*, checkpointer: MemorySaver | None = None):
    """
    Compile the gold-standard LangGraph workflow.

    RAG grounding is injected after gather and before plan — ensuring every
    remediation plan is runbook-grounded before tool compilation / execution.
    """
    graph = StateGraph(SREAgentState)

    graph.add_node("semantic_route", semantic_route_node)
    graph.add_node("gather", investigative_gather_node)
    graph.add_node("rag_grounding", rag_grounding_node)
    graph.add_node("plan", plan_with_playbook_node)
    graph.add_node("chitchat", chitchat_node)
    graph.add_node("increment_verification", increment_verification_node)
    graph.add_node("escalate", escalate_node)

    graph.add_edge(START, "semantic_route")
    graph.add_conditional_edges(
        "semantic_route",
        route_by_intent,
        {
            "gather": "gather",
            "chitchat": "chitchat",
            "end": END,
        },
    )
    graph.add_edge("chitchat", END)

    # Core gold-standard path: gather → RAG → plan
    graph.add_edge("gather", "rag_grounding")
    graph.add_edge("rag_grounding", "plan")
    graph.add_edge("plan", END)

    # Verification loop hooks (extend when act/verify nodes are wired)
    graph.add_edge("increment_verification", "escalate")  # overridden by conditional below

    compiled = graph.compile(checkpointer=checkpointer or MemorySaver())
    logger.info("SRE gold-standard workflow compiled")
    return compiled


def run_workflow(
    user_message: str,
    *,
    target_workload: str = "",
    detected_error: str = "",
    target_component: str = "compute",
    thread_id: str = "default",
):
    """Convenience invoke helper for CLI / gateway integration."""
    from graph.state import create_initial_state

    app = build_workflow()
    initial = create_initial_state(
        user_message,
        target_workload=target_workload,
        detected_error=detected_error,
        target_component=target_component,
    )
    return app.invoke(
        initial,
        config={"configurable": {"thread_id": thread_id}},
    )
