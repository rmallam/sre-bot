FROM node:22-alpine
WORKDIR /app

# Copy shared types
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh

# Copy agent
COPY agents/watcher/package*.json ./agents/watcher/
RUN cd agents/watcher && npm ci --omit=dev
COPY agents/watcher/ ./agents/watcher/

WORKDIR /app/agents/watcher
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/watcher/tsconfig.json
CMD ["npm", "start"]
