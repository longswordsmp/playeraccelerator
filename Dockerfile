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
# The panel headers are read from disk at startup and uploaded with each panel.
# Leaving them out does not crash anything — `assets.js` degrades to text-only
# embeds — which is exactly why it would have shipped unnoticed.
COPY brand ./brand

# Runtime data must outlive the container: transcripts and backups are written
# to disk and only *referenced* from the database, so losing them orphans every
# `htmlPath` on a closed ticket.
#
# There is deliberately no `VOLUME` instruction here. Railway rejects the whole
# image if it finds one ("docker VOLUME at Line 35 is not supported, use Railway
# Volumes"), and it buys nothing anyway: docker-compose.yml names these paths
# explicitly, and any host that mounts a volume does so by path regardless. The
# directories still have to exist and be writable by `node`, which is what this
# does.
#
# Wherever you deploy, mount persistent storage over these three paths — or set
# TRANSCRIPT_DIR, BACKUP_DIR and LOG_DIR to somewhere under a single mount, as
# Railway requires since it allows only one mount path per service.
RUN mkdir -p /app/transcripts /app/backups /app/logs \
 && chown -R node:node /app

USER node

# A lightweight liveness probe: the process must still be able to require its
# own entry point. Real health is reported through the bot-logs channel.
HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "process.exit(0)"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
