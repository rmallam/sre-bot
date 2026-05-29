FROM node:22-alpine
WORKDIR /app

# Copy shared library
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh

# Copy agent package files
COPY agents/commander/package*.json ./agents/commander/
RUN cd agents/commander && npm ci --omit=dev

# Copy agent source files
COPY agents/commander/ ./agents/commander/

WORKDIR /app/agents/commander
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/commander/tsconfig.json
CMD ["npm", "start"]
