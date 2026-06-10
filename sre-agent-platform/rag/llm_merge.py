"""LLM-assisted merge for duplicate RAG playbooks."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_MERGE_PROMPT = """You are an SRE runbook editor. Merge these two similar troubleshooting playbooks into ONE cohesive markdown runbook.

Rules:
- Combine overlapping steps; remove redundancy.
- Use generic placeholders: {workload}, {namespace} — never hard-code app names.
- Keep markdown structure: title, symptoms, root cause, remediation steps, verification.
- Output ONLY the merged markdown — no preamble or explanation.

## Playbook A
{canonical}

## Playbook B
{duplicate}
"""


def llm_merge_enabled() -> bool:
    return os.getenv("SRE_RAG_DEDUP_LLM_MERGE", "true").lower() in ("1", "true", "yes")


def _merge_model() -> str:
    return os.getenv(
        "SRE_RAG_DEDUP_LLM_MODEL",
        os.getenv("OPENROUTER_TOOL_SELECT_MODEL", "google/gemini-2.5-flash"),
    )


def _resolve_llm_client():
    """Pick ChatOpenAI (OpenRouter/OpenAI/Gemini-compatible) or native Gemini."""
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")
    gemini_key = os.getenv("GEMINI_API_KEY")

    if openrouter_key or openai_key:
        from langchain_openai import ChatOpenAI

        api_key = openrouter_key or openai_key
        base_url = os.getenv("OPENROUTER_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        if not base_url and openrouter_key:
            base_url = "https://openrouter.ai/api/v1"
        kwargs: dict = {
            "model": _merge_model(),
            "api_key": api_key,
            "temperature": 0.1,
            "max_tokens": 2048,
        }
        if base_url:
            kwargs["base_url"] = base_url
        return ChatOpenAI(**kwargs)

    if gemini_key:
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI

            return ChatGoogleGenerativeAI(
                model=os.getenv("SRE_RAG_DEDUP_GEMINI_MODEL", "gemini-2.5-flash"),
                google_api_key=gemini_key,
                temperature=0.1,
                max_output_tokens=2048,
            )
        except ImportError:
            from langchain_openai import ChatOpenAI

            return ChatOpenAI(
                model=_merge_model(),
                api_key=gemini_key,
                base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
                temperature=0.1,
                max_tokens=2048,
            )

    return None


def merge_playbooks_with_llm(canonical: str, duplicate: str) -> str | None:
    """Return LLM-merged markdown, or None to fall back to deterministic merge."""
    if not llm_merge_enabled():
        return None
    if not canonical.strip() or not duplicate.strip():
        return None

    llm = _resolve_llm_client()
    if llm is None:
        logger.debug("RAG dedup LLM merge skipped — no API key")
        return None

    try:
        from langchain_core.messages import HumanMessage

        prompt = _MERGE_PROMPT.format(canonical=canonical.strip(), duplicate=duplicate.strip())
        response = llm.invoke([HumanMessage(content=prompt)])
        text = getattr(response, "content", None)
        if isinstance(text, str) and text.strip():
            return text.strip()
        if isinstance(text, list):
            parts = [p.get("text", "") if isinstance(p, dict) else str(p) for p in text]
            merged = "".join(parts).strip()
            return merged or None
    except Exception:
        logger.exception("RAG dedup LLM merge failed — using line merge fallback")
    return None
