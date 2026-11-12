import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // src/instrumentation.ts keeps the signaling relay alive (see that file).
  output: "standalone",
  typescript: {
    // Production builds must fail on type errors — never ship silently broken.
    ignoreBuildErrors: false,
  },
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
