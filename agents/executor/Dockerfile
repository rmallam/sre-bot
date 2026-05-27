FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY agents/executor/package*.json ./agents/executor/
RUN cd agents/executor && npm ci --omit=dev
COPY agents/executor/ ./agents/executor/
WORKDIR /app/agents/executor
EXPOSE 8080
CMD ["npm", "start"]
