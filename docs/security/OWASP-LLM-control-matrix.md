# OWASP LLM Top 10 (2025) — Control Matrix

| ID | Risk | Control | Owner | Maturity |
|----|------|---------|-------|----------|
| LLM01 | Prompt injection | Sanitize chat + facts; structured plan output | security-agent | v1 |
| LLM02 | Sensitive disclosure | Minimize + redact before LLM | security-agent, investigator | v1 |
| LLM06 | Excessive agency | AUTONOMY_MODE, authorize-action, maxIterations | orchestrator | v1 |
| LLM10 | Unbounded consumption | Log truncation, iteration limits | investigator, orchestrator | v1 |

v2: AI gateway (`docker compose --profile v2`), OPA (`policy/authorize.rego`), SIEM (`SIEM_ENDPOINT`).
