FROM node:22-alpine
WORKDIR /app

COPY shared/package*.json ./shared/
RUN cd shared && npm ci --omit=dev
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh

COPY agents/debug-mcp/package*.json ./agents/debug-mcp/
RUN cd agents/debug-mcp && npm ci --omit=dev
COPY agents/debug-mcp/ ./agents/debug-mcp/

WORKDIR /app/agents/debug-mcp
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/debug-mcp/tsconfig.json
CMD ["npm", "start"]
