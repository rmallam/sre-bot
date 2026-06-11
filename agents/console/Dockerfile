# ── Build React UI ────────────────────────────────────────────────────────────
FROM node:22-alpine AS web-build
WORKDIR /app/agents/console
COPY agents/console/package*.json ./
RUN npm ci
COPY agents/console/web ./web
COPY agents/console/tsconfig.json ./
RUN npm run build:web

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
COPY shared/package*.json ./shared/
RUN cd shared && npm ci --omit=dev
COPY shared/ ./shared/
COPY agents/console/package*.json ./agents/console/
RUN cd agents/console && npm ci --omit=dev
COPY agents/console/tsconfig.json ./agents/console/
COPY agents/console/src ./agents/console/src
COPY --from=web-build /app/agents/console/web/dist ./agents/console/web/dist
WORKDIR /app/agents/console
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/console/tsconfig.json
CMD ["npm", "start"]
