#!/usr/bin/env python3
"""Load runbook seed data from shared/data/runbooks/*.json."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger("bootstrap_rag")

_FALLBACK_RUNBOOKS: list[dict] = [
    {
        "error_signature": "OOMKilled",
        "target_component": "compute",
        "playbook_markdown": "# OOMKilled Runbook\n\nSee shared/data/runbooks/",
    },
]


def _repo_shared_data() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "shared" / "data"


def load_runbook_corpus() -> list[dict]:
    """Load and dedupe all runbooks from shared/data/runbooks/*.json."""
    candidates = [
        _repo_shared_data() / "runbooks",
        Path("/app/shared/data/runbooks"),
    ]
    for runbooks_dir in candidates:
        if not runbooks_dir.is_dir():
            continue
        merged: dict[str, dict] = {}
        for path in sorted(runbooks_dir.glob("*.json")):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                raise ValueError(f"{path}: expected JSON array")
            for row in data:
                key = f"{row['target_component']}::{row['error_signature']}"
                merged[key] = row
        if merged:
            rows = sorted(
                merged.values(),
                key=lambda r: (r["target_component"], r["error_signature"]),
            )
            logger.info("Loaded %s runbooks from %s", len(rows), runbooks_dir)
            return rows

    # Legacy monolithic fallback
    legacy = [
        _repo_shared_data() / "sre-rag-runbooks.json",
        Path("/app/shared/data/sre-rag-runbooks.json"),
    ]
    for path in legacy:
        if path.is_file():
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list) and data:
                logger.info("Loaded %s runbooks from legacy %s", len(data), path)
                return data

    logger.warning("No runbook corpus found — using fallback seed")
    return _FALLBACK_RUNBOOKS


def _load_runbook_seed() -> list[dict]:
    return load_runbook_corpus()
