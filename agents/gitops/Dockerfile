FROM node:22-alpine
WORKDIR /app

# Install curl, git, and openssh-client
RUN apk add --no-cache curl git openssh-client

# Download and install kubectl
RUN curl -LO "https://dl.k8s.io/release/v1.28.0/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

# Copy shared library
COPY shared/ ./shared/

# Copy agent package files
COPY agents/gitops/package*.json ./agents/gitops/
RUN cd agents/gitops && npm ci --omit=dev

# Copy agent source files
COPY agents/gitops/ ./agents/gitops/

WORKDIR /app/agents/gitops
EXPOSE 8080
CMD ["npm", "start"]
