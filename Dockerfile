FROM node:20-alpine

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY server.js ./
COPY data/schema.sql ./data/schema.sql

EXPOSE 3001

CMD ["node", "--env-file-if-exists=.env", "server.js"]
