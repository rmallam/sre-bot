FROM node:22-alpine
WORKDIR /app

# Copy shared library
COPY shared/ ./shared/

# Copy agent package files
COPY agents/commander/package*.json ./agents/commander/
RUN cd agents/commander && npm ci --omit=dev

# Copy agent source files
COPY agents/commander/ ./agents/commander/

WORKDIR /app/agents/commander
EXPOSE 8080
CMD ["npm", "start"]
