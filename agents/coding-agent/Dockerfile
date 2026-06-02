FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git openssh-client
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh
COPY agents/coding-agent/package*.json ./agents/coding-agent/
RUN cd agents/coding-agent && npm install --omit=dev
COPY agents/coding-agent/ ./agents/coding-agent/
WORKDIR /app/agents/coding-agent
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/coding-agent/tsconfig.json
CMD ["npm", "start"]
