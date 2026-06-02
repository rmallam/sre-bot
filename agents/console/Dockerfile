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
WORKDIR /app/agents/console
COPY agents/console/package*.json ./
RUN npm ci --omit=dev
COPY agents/console/tsconfig.json ./
COPY agents/console/src ./src
COPY --from=web-build /app/agents/console/web/dist ./web/dist
EXPOSE 8080
ENV TSX_TSCONFIG_PATH=/app/agents/console/tsconfig.json
CMD ["npm", "start"]
