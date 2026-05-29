FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh
COPY agents/orchestrator/package*.json ./agents/orchestrator/
RUN cd agents/orchestrator && npm ci --omit=dev
COPY agents/orchestrator/ ./agents/orchestrator/
WORKDIR /app/agents/orchestrator
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/orchestrator/tsconfig.json
CMD ["npm", "start"]
