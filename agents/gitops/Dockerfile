FROM node:22-alpine
WORKDIR /app

ARG TARGETARCH=amd64

# Install curl, git, and openssh-client
RUN apk add --no-cache curl git openssh-client

# kubectl + helm — match container CPU arch (fixes helm Go crash on Podman/Mac arm64)
RUN ARCH="${TARGETARCH}" \
    && curl -fsSL "https://dl.k8s.io/release/v1.35.0/bin/linux/${ARCH}/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && curl -fsSL "https://get.helm.sh/helm-v3.14.4-linux-${ARCH}.tar.gz" -o /tmp/helm.tgz \
    && tar -xzf /tmp/helm.tgz -C /tmp \
    && mv "/tmp/linux-${ARCH}/helm" /usr/local/bin/helm \
    && chmod +x /usr/local/bin/helm \
    && rm -rf /tmp/helm.tgz "/tmp/linux-${ARCH}" \
    && kubectl version --client=true \
    && helm version --short

# Copy shared library
COPY shared/package*.json ./shared/
RUN cd shared && npm ci --omit=dev
COPY shared/ ./shared/
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod +x /app/scripts/container-entrypoint.sh

# Copy agent package files
COPY agents/gitops/package*.json ./agents/gitops/
RUN cd agents/gitops && npm ci --omit=dev

# Copy agent source files
COPY agents/gitops/ ./agents/gitops/

WORKDIR /app/agents/gitops
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/gitops/tsconfig.json
CMD ["npm", "start"]
