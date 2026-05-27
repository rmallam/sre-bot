FROM node:22-alpine
WORKDIR /app

# Copy shared types
COPY shared/ ./shared/

# Copy agent
COPY agents/watcher/package*.json ./agents/watcher/
RUN cd agents/watcher && npm ci --omit=dev
COPY agents/watcher/ ./agents/watcher/

WORKDIR /app/agents/watcher
EXPOSE 8080
CMD ["npm", "start"]
