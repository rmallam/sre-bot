FROM node:22-alpine
WORKDIR /app

# Copy shared library
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh

# Copy agent package files
COPY agents/hil/package*.json ./agents/hil/
RUN cd agents/hil && npm ci --omit=dev

# Copy agent source files
COPY agents/hil/ ./agents/hil/

WORKDIR /app/agents/hil
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/hil/tsconfig.json
CMD ["npm", "start"]
