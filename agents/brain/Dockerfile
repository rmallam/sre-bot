FROM node:22-alpine
WORKDIR /app

# Copy shared library
COPY shared/ ./shared/

# Copy agent package files
COPY agents/brain/package*.json ./agents/brain/
RUN cd agents/brain && npm ci --omit=dev

# Copy agent source files
COPY agents/brain/ ./agents/brain/

WORKDIR /app/agents/brain
EXPOSE 8080
CMD ["npm", "start"]
