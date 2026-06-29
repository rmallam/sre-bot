"""Tests for runbook corpus loading."""

from __future__ import annotations

from pathlib import Path

import pytest


def test_load_runbook_corpus_count():
    from scripts.runbook_corpus import load_runbook_corpus

    rows = load_runbook_corpus()
    assert len(rows) >= 70
    sigs = {(r["target_component"], r["error_signature"]) for r in rows}
    assert len(sigs) == len(rows), "duplicate signatures in corpus"


def test_runbook_required_fields():
    from scripts.runbook_corpus import load_runbook_corpus

    for row in load_runbook_corpus():
        assert row["error_signature"]
        assert row["target_component"] in {
            "compute",
            "storage",
            "network",
            "gitops",
            "database",
            "security",
        }
        md = row["playbook_markdown"]
        assert "## Symptoms" in md
        assert "## Diagnosis" in md
        assert "## Verification" in md


def test_taxonomy_json_exists():
    root = Path(__file__).resolve().parents[2]
    taxonomy = root / "shared" / "data" / "k8s-issue-taxonomy.json"
    assert taxonomy.is_file()
