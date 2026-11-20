import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { ClientErrorReporter } from "./client-error-report";

const TITLE = "Pico — calls that weigh nothing";
const manrope = Manrope({ subsets: ["latin"], display: "swap", variable: "--font-manrope" });
const DESCRIPTION =
  "Peer-to-peer video calling that sips data, battery and CPU. Built to work on a single bar of signal. No accounts, no downloads, nothing recorded.";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: TITLE,
  description: DESCRIPTION,
  keywords: ["video call", "p2p", "webrtc", "lightweight", "low bandwidth", "meeting"],
  // Referrer-Policy is no-referrer (see next.config.ts) — the room code in the
  // URL never leaves the browser via Referer headers.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Pico", statusBarStyle: "default" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "Pico",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Pico — peer-to-peer video calls" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={manrope.variable}>
      <body className="font-sans antialiased bg-white text-foreground">
        {/* Version guard: registers the app-shell service worker and reloads
            once when a hashed chunk fails (deploy under a long-lived tab). */}
        <script src="/version-guard.js" defer />
        {/* Global client error reporting → /api/client-error (throttled, no PII). */}
        <ClientErrorReporter />
        {children}
        <Toaster
          position="top-center"
          gap={8}
          toastOptions={{
            style: {
              borderRadius: "16px",
              fontSize: "13px",
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              background: "rgba(13,13,15,0.92)",
              color: "#fff",
              border: "none",
              backdropFilter: "blur(12px)",
            },
        }}
        />
      </body>
    </html>
  );
}
