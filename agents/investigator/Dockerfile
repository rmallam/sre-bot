FROM node:22-alpine
WORKDIR /app

# Install Git and SSH client
RUN apk add --no-cache git openssh-client

# Copy shared library
COPY shared/package*.json ./shared/
RUN cd shared && npm ci --omit=dev
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh

# Copy agent package files
COPY agents/investigator/package*.json ./agents/investigator/
RUN cd agents/investigator && npm ci --omit=dev

# Copy agent source files
COPY agents/investigator/ ./agents/investigator/

WORKDIR /app/agents/investigator
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/investigator/tsconfig.json
CMD ["npm", "start"]
