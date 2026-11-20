# Build from the repository root; public client settings are build-time values.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SIGNALING_URL=
ARG NEXT_PUBLIC_SOCKET_PATH=/signal/
ARG NEXT_PUBLIC_ROOM_INFO_URL=/info
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG PICO_VERSION=
ENV NEXT_PUBLIC_SIGNALING_URL=$NEXT_PUBLIC_SIGNALING_URL \
    NEXT_PUBLIC_SOCKET_PATH=$NEXT_PUBLIC_SOCKET_PATH \
    NEXT_PUBLIC_ROOM_INFO_URL=$NEXT_PUBLIC_ROOM_INFO_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    PICO_VERSION=$PICO_VERSION \
    NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Match the builder's glibc runtime for native modules such as sharp.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=node:node /app/.next/standalone ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
