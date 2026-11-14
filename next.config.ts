import type { NextConfig } from "next";
import fs from "node:fs";

// Deployment version: PICO_VERSION env when set, else the git short hash of
// the build context, else package.json's version — with a loud warning on
// that last fallback (keep the order in sync with src/lib/server-version.ts,
// which re-resolves the SAME value at runtime; Docker builds pin it via a
// .pico-version stamp written by Dockerfile.standalone, so an image without
// git still matches its build). One source, three consumers that MUST agree:
//  - client bundle (NEXT_PUBLIC_PICO_VERSION below → socket version check),
//  - every HTTP response (x-pico-version header → service worker cache
//    versioning),
//  - /api/health (server version reporting).
const pkgVersion = (JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string }).version;

let PICO_VERSION = process.env.PICO_VERSION || "";
if (!PICO_VERSION) {
  try {
    PICO_VERSION = require("node:child_process")
      .execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout (or no git binary) */
  }
}
if (!PICO_VERSION) {
  console.error(
    `[pico] PICO_VERSION is unset and no git checkout found — falling back to ` +
      `package.json "${pkgVersion}", which is NOT unique per deploy. Set PICO_VERSION ` +
      `(e.g. the git short SHA) or build from a git checkout — see DEPLOY.md.`,
  );
  PICO_VERSION = pkgVersion || "dev";
}

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_PICO_VERSION: PICO_VERSION },
  // src/instrumentation.ts keeps the signaling relay alive (see that file).
  output: "standalone",
  // The signaling relay is embedded in the Next.js server process (see
  // src/lib/relay-server.ts). Keeping socket.io external makes output file
  // tracing copy it into .next/standalone/node_modules, so the production
  // bundle is fully self-contained — no second process, no spawn.
  serverExternalPackages: ["socket.io"],
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
          // Deployment version — the service worker keys its per-version
          // caches off this; /api/health reports it too.
          { key: "x-pico-version", value: PICO_VERSION },
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
