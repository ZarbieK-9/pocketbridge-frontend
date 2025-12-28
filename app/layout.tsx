import type React from "react"
import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { ServiceWorkerRegister } from "@/components/service-worker-register"
import { BackgroundSync } from "@/components/background-sync"
import { ErrorBoundary } from "@/components/error-boundary"
import { OfflineIndicator } from "@/components/offline-indicator"
import { WebVitalsReporter } from "@/components/web-vitals-reporter"
import { UserProfileRestore } from "@/components/user-profile-restore"
import { OnboardingGuard } from "@/components/onboarding/onboarding-guard"
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
  openGraph: {
    title: "PocketBridge - Secure Cross-Device Workspace",
    description: "End-to-end encrypted clipboard sync, scratchpad, messaging, and file sharing across your devices",
    type: "website",
    siteName: "PocketBridge",
    images: [
      {
        url: "/icon-512.jpg",
        width: 512,
        height: 512,
        alt: "PocketBridge",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "PocketBridge - Secure Cross-Device Workspace",
    description: "End-to-end encrypted clipboard sync, scratchpad, messaging, and file sharing across your devices",
    images: ["/icon-512.jpg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
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
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'PocketBridge',
              description: 'End-to-end encrypted cross-device workspace',
              url: typeof window !== 'undefined' ? window.location.origin : '',
              applicationCategory: 'ProductivityApplication',
              operatingSystem: 'Web',
            }),
          }}
        />
      </head>
      <body className={`${inter.className} font-sans antialiased`}>
        <ErrorBoundary>
          <ServiceWorkerRegister />
          <BackgroundSync />
          <WebVitalsReporter />
          <UserProfileRestore />
          <OnboardingGuard>
            {children}
          </OnboardingGuard>
          <OfflineIndicator />
          <Analytics />
        </ErrorBoundary>
      </body>
    </html>
  )
}
