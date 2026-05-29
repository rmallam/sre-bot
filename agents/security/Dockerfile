FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh
COPY agents/security/package*.json ./agents/security/
RUN cd agents/security && npm ci --omit=dev
COPY agents/security/ ./agents/security/
WORKDIR /app/agents/security
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/security/tsconfig.json
CMD ["npm", "start"]
