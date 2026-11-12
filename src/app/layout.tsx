import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pico — featherlight video calls",
  description:
    "Peer-to-peer video calling that sips data and CPU. Works on 2G, no downloads, nothing recorded.",
  keywords: ["video call", "p2p", "webrtc", "lightweight", "low bandwidth", "meeting"],
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%231c1c1e'/%3E%3Cpath d='M22 22h14a8 8 0 0 1 8 8v0a8 8 0 0 1-8 8H22a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4z' fill='%23fff'/%3E%3Crect x='44' y='27' width='8' height='10' rx='2' fill='%2334c759'/%3E%3C/svg%3E",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white text-foreground`}
      >
        {children}
        <Toaster position="top-center" gap={8} toastOptions={{ style: { borderRadius: '14px', fontSize: '13px' } }} />
      </body>
    </html>
  );
}
