"""Tests for RAG dedup parameterization and merge helpers."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

rag_pkg = types.ModuleType("rag")
rag_pkg.__path__ = [str(ROOT / "rag")]  # type: ignore[attr-defined]
sys.modules["rag"] = rag_pkg

for name in ("pg_vector_store", "retriever", "llm_merge"):
    mod = types.ModuleType(f"rag.{name}")
    sys.modules[f"rag.{name}"] = mod
    setattr(rag_pkg, name, mod)

sys.modules["rag.pg_vector_store"].PgVectorStore = object  # type: ignore[attr-defined]
sys.modules["rag.pg_vector_store"].StoredRunbook = object  # type: ignore[attr-defined]
sys.modules["rag.retriever"].EmbeddingClient = object  # type: ignore[attr-defined]
sys.modules["rag.llm_merge"].merge_playbooks_with_llm = lambda *a, **k: None  # type: ignore[attr-defined]

spec = importlib.util.spec_from_file_location("rag.dedup_worker", ROOT / "rag" / "dedup_worker.py")
assert spec and spec.loader
dedup_worker = importlib.util.module_from_spec(spec)
sys.modules["rag.dedup_worker"] = dedup_worker
spec.loader.exec_module(dedup_worker)

parameterize_playbook_markdown = dedup_worker.parameterize_playbook_markdown
_merge_markdown = dedup_worker._merge_markdown


def test_parameterize_preserves_mime_types() -> None:
    text = "Set Content-Type: application/json and Accept: text/html"
    out = parameterize_playbook_markdown(text)
    assert "application/json" in out
    assert "text/html" in out
    assert "{namespace}/{workload}" not in out


def test_parameterize_replaces_k8s_paths() -> None:
    text = "kubectl rollout restart deployment/payments-api -n checkout"
    out = parameterize_playbook_markdown(text)
    assert "{namespace}/{workload}" in out


def test_parameterize_workload_line() -> None:
    text = "**Workload:** api-server (production)"
    out = parameterize_playbook_markdown(text)
    assert "{workload}" in out
    assert "{namespace}" in out


def test_merge_markdown_line_fallback_without_llm(monkeypatch) -> None:
    monkeypatch.setenv("SRE_RAG_DEDUP_LLM_MERGE", "false")
    a = "## Steps\n- restart pod"
    b = "## Steps\n- check logs"
    merged = _merge_markdown(a, b)
    assert "restart pod" in merged
    assert "check logs" in merged
