FROM node:22-alpine
WORKDIR /app

# Install Git and SSH client
RUN apk add --no-cache git openssh-client

# Copy shared library
COPY shared/ ./shared/

# Copy agent package files
COPY agents/investigator/package*.json ./agents/investigator/
RUN cd agents/investigator && npm ci --omit=dev

# Copy agent source files
COPY agents/investigator/ ./agents/investigator/

WORKDIR /app/agents/investigator
EXPOSE 8080
CMD ["npm", "start"]
