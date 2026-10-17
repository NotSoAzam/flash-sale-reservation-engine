# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy SQL migrations and Lua scripts that are loaded from filesystem
COPY src/db/migrations ./dist/db/migrations
COPY src/redis/lua ./dist/redis/lua

EXPOSE 3000

CMD ["node", "dist/server.js"]
