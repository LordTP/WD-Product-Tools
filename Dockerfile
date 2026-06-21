# --- deps: install node_modules (with build tools for better-sqlite3) ---
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compile the Next.js standalone bundle ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner: minimal image that serves the app ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# SQLite lives on a mounted volume so data survives container restarts/redeploys.
ENV DATABASE_PATH=/data/data.db
ENV MIGRATIONS_DIR=/app/drizzle

RUN useradd -m -u 1001 app && mkdir -p /data && chown app:app /data

# Standalone server bundle + static assets + migrations (for boot-time self-init).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
# better-sqlite3 is a native module kept external; ensure it's present in runtime.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

USER app
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
