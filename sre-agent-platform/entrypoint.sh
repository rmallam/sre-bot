#!/usr/bin/env sh
set -e
cd /app/sre-agent-platform
exec uvicorn server:app --host 0.0.0.0 --port 8080
