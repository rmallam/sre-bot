FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY agents/security/package*.json ./agents/security/
RUN cd agents/security && npm ci --omit=dev
COPY agents/security/ ./agents/security/
WORKDIR /app/agents/security
EXPOSE 8080
CMD ["npm", "start"]
