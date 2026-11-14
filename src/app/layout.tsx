import type { Metadata, Viewport } from "next";
import { Manrope, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const TITLE = "Pico — calls that weigh nothing";
const DESCRIPTION =
  "Peer-to-peer video calling that sips data, battery and CPU. Built to work on a single bar of signal. No accounts, no downloads, nothing recorded.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
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
  maximumScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${manrope.variable} ${geistMono.variable} font-sans antialiased bg-white text-foreground`}
      >
        {/* App-shell service worker: repeat joins load from cache (public/sw.js).
            HTTPS-only (SW requirement), production-only (keep dev uncached). */}
        {process.env.NODE_ENV === "production" && (
          <script
            dangerouslySetInnerHTML={{
              __html:
                "if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}",
            }}
          />
        )}
        {children}
        <Toaster
          position="top-center"
          gap={8}
          toastOptions={{
            style: {
              borderRadius: "16px",
              fontSize: "13px",
              fontWeight: 600,
              fontFamily: "var(--font-manrope)",
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
