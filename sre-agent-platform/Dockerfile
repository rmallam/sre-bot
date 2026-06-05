FROM python:3.12-slim-bookworm

WORKDIR /app/sre-agent-platform

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY sre-agent-platform/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt uvicorn[standard] fastapi

COPY sre-agent-platform/ ./

RUN chmod +x entrypoint.sh

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/sre-agent-platform

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=90s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')" || exit 1

CMD ["./entrypoint.sh"]
