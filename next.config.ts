import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // src/instrumentation.ts keeps the signaling relay alive (see that file).
  output: "standalone",
  // Signaling and room-info ride the SAME origin/port as the app: these
  // rewrites proxy them to the relay processes server-side. This is what
  // makes the call relay reachable no matter which front door a browser
  // uses (preview proxy, :81 gateway, direct :3000) — none of them need to
  // understand port-routing query params. socket.io's websocket upgrade is
  // attempted first by the client and transparently falls back to
  // long-polling where upgrades are not proxied; payloads are tiny.
  async rewrites() {
    const relay = process.env.RELAY_UPSTREAM ?? "http://127.0.0.1:3003";
    const info = process.env.INFO_UPSTREAM ?? "http://127.0.0.1:3004";
    return [
      { source: "/signal/:path*", destination: `${relay}/:path*` },
      { source: "/signal", destination: `${relay}/` },
      { source: "/info/:path*", destination: `${info}/:path*` },
      { source: "/info", destination: `${info}/` },
    ];
  },
  typescript: {
    // Production builds must fail on type errors — never ship silently broken.
    ignoreBuildErrors: false,
  },
  // socket.io's client always requests its path WITH a trailing slash
  // (/signal/?EIO=4…). Next would 308-redirect that to /signal, which XHR
  // follows but WebSocket upgrades cannot — so skip the redirect and let the
  // rewrite match directly.
  skipTrailingSlashRedirect: true,
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Clickjacking — the call UI must never be embedded by another site.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Invite links contain the room code; never leak it via Referer.
          { key: "Referrer-Policy", value: "no-referrer" },
          // Only this origin may open cameras, microphones and screen capture.
          {
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
