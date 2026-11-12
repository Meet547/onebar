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

/** Waveform app mark — black tile, white bars, one green voice bar. */
const ICON = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0d0d0f"/><rect x="14" y="26" width="5" height="12" rx="2.5" fill="#fff"/><rect x="23" y="20" width="5" height="24" rx="2.5" fill="#fff"/><rect x="32" y="14" width="5" height="36" rx="2.5" fill="#30d158"/><rect x="41" y="22" width="5" height="20" rx="2.5" fill="#fff"/><rect x="50" y="28" width="5" height="8" rx="2.5" fill="#fff"/></svg>`,
);

export const metadata: Metadata = {
  title: "Pico — calls that weigh nothing",
  description:
    "Peer-to-peer video calling that sips data, battery and CPU. Built to work on a single bar of signal. No accounts, no downloads, nothing recorded.",
  keywords: ["video call", "p2p", "webrtc", "lightweight", "low bandwidth", "meeting"],
  icons: {
    icon: `data:image/svg+xml,${ICON}`,
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
