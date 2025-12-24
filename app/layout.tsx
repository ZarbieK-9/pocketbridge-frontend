import type React from "react"
import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { ServiceWorkerRegister } from "@/components/service-worker-register"
import { BackgroundSync } from "@/components/background-sync"
import "@/lib/utils/debug" // Enable browser console debugging
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "PocketBridge - Secure Cross-Device Workspace",
  description: "End-to-end encrypted clipboard sync, scratchpad, messaging, and file sharing across your devices",
  generator: "next.js",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon-192.jpg",
    apple: "/icon-512.jpg",
  },
}

export const viewport: Viewport = {
  themeColor: "#2F80ED",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} font-sans antialiased`}>
        <ServiceWorkerRegister />
        <BackgroundSync />
        {children}
        <Analytics />
      </body>
    </html>
  )
}
