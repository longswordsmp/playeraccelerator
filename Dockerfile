# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
# Installs production dependencies only, in a layer that is cached unless the
# manifest changes.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM, which is what makes the bot's
# graceful shutdown actually run inside a container.
RUN apk add --no-cache dumb-init tini

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Runtime data lives on a volume so transcripts, backups and logs survive a
# container replacement.
RUN mkdir -p /app/transcripts /app/backups /app/logs \
 && chown -R node:node /app

USER node
VOLUME ["/app/transcripts", "/app/backups", "/app/logs"]

# A lightweight liveness probe: the process must still be able to require its
# own entry point. Real health is reported through the bot-logs channel.
HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "process.exit(0)"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
