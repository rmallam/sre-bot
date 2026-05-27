FROM node:22-alpine
WORKDIR /app

# Copy shared library
COPY shared/ ./shared/

# Copy agent package files
COPY agents/hil/package*.json ./agents/hil/
RUN cd agents/hil && npm ci --omit=dev

# Copy agent source files
COPY agents/hil/ ./agents/hil/

WORKDIR /app/agents/hil
EXPOSE 8080
CMD ["npm", "start"]
