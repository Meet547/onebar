# Pico — signaling relay (socket.io, ~KB of traffic per meeting)
# Build:  docker build -t pico-signaling .
# Run:    docker run -p 3003:3003 -p 3004:3004 pico-signaling

FROM oven/bun:1
WORKDIR /srv
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.ts .

ENV PORT=3003 \
    INFO_PORT=3004 \
    SOCKET_PATH=/socket.io

EXPOSE 3003 3004
CMD ["bun", "index.ts"]
