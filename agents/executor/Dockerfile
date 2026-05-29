FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh
COPY agents/executor/package*.json ./agents/executor/
RUN cd agents/executor && npm ci --omit=dev
COPY agents/executor/ ./agents/executor/
WORKDIR /app/agents/executor
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/executor/tsconfig.json
CMD ["npm", "start"]
