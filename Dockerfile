# Pico — Next.js app (standalone output)
# Build:  docker build -t pico-app .
# Run:    docker run -p 3000:3000 -e NEXT_PUBLIC_SIGNALING_URL=... pico-app

# ---- deps ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- build ----
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public runtime config is baked into the client bundle at build time.
# Point these at your signaling deployment (see DEPLOY.md).
ARG NEXT_PUBLIC_SIGNALING_URL=/
ARG NEXT_PUBLIC_SOCKET_PATH=/socket.io
ARG NEXT_PUBLIC_ROOM_INFO_URL=/info
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SIGNALING_URL=$NEXT_PUBLIC_SIGNALING_URL \
    NEXT_PUBLIC_SOCKET_PATH=$NEXT_PUBLIC_SOCKET_PATH \
    NEXT_PUBLIC_ROOM_INFO_URL=$NEXT_PUBLIC_ROOM_INFO_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

RUN bun run build

# ---- run ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next/standalone ./
# (the build script already copies .next/static and public into standalone)

EXPOSE 3000
CMD ["node", "server.js"]
