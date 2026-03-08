# ── Stage 1: Build native modules (needs python3/make/g++ for better-sqlite3) ─
FROM node:20-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Lean runtime image ───────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# libsqlite3 is needed at runtime by the compiled better-sqlite3 addon
RUN apk add --no-cache sqlite-libs

# Copy compiled node_modules (includes better-sqlite3 .node binary)
COPY --from=deps /app/node_modules ./node_modules

# App source
COPY server.js ./
COPY public/   ./public/

# Persistent data directory for SQLite DB
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node
CMD ["node", "server.js"]
