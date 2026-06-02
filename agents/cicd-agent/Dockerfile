FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git openssh-client
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh
COPY agents/cicd-agent/package*.json ./agents/cicd-agent/
RUN cd agents/cicd-agent && npm install --omit=dev
COPY agents/cicd-agent/ ./agents/cicd-agent/
WORKDIR /app/agents/cicd-agent
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/cicd-agent/tsconfig.json
CMD ["npm", "start"]
