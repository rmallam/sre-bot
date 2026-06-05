"""
LangGraph SRE agent state — TypedDict with annotated message accumulation.

Keys align with the gold-standard topology:
  gateway route → gather → RAG grounding → plan → act → verify
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage, HumanMessage
from langgraph.graph.message import add_messages


class SREAgentState(TypedDict, total=False):
    """
    Shared state for the SRE LangGraph workflow.

    ``total=False`` allows partial updates from individual nodes while
    preserving required keys at workflow entry.
    """

    # Conversation / thought log (LangGraph standard pattern)
    messages: Annotated[list[BaseMessage], add_messages]

    # Investigation outputs
    detected_error: str  # e.g. CrashLoopBackOff, OOMKilled, ImagePullBackOff
    target_workload: str  # pod / deployment / statefulset name
    target_component: str  # RAG metadata filter: storage | network | compute | gitops

    # Gateway semantic router outcome
    route_intent: str  # chitchat | diagnose | remediate | default
    route_score: float

    # RAG grounding (official runbook markdown injected into planner)
    retrieved_playbook: str

    # Remediation loop guard
    verification_attempts: int

    # Downstream planner / executor artifacts (extensible)
    remediation_plan: str
    execution_status: str


def create_initial_state(
    user_message: str,
    *,
    target_workload: str = "",
    detected_error: str = "",
    target_component: str = "compute",
) -> SREAgentState:
    """Bootstrap state for a new operator session."""
    return SREAgentState(
        messages=[HumanMessage(content=user_message)],
        detected_error=detected_error,
        target_workload=target_workload,
        target_component=target_component,
        route_intent="",
        route_score=0.0,
        retrieved_playbook="",
        verification_attempts=0,
        remediation_plan="",
        execution_status="pending",
    )
