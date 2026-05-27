FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY agents/orchestrator/package*.json ./agents/orchestrator/
RUN cd agents/orchestrator && npm ci --omit=dev
COPY agents/orchestrator/ ./agents/orchestrator/
WORKDIR /app/agents/orchestrator
EXPOSE 8080
CMD ["npm", "start"]
