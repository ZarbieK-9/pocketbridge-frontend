import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Allow cross-origin requests from local network IPs during development
  allowedDevOrigins: [
    '192.168.18.8',
    '192.168.56.1',
    'localhost',
    '127.0.0.1',
  ],
  turbopack: {
    // Treat this folder (pocketbridge) as the workspace root
    root: '.',
  },
      // Note: For full PWA support in production, use next-pwa package
}

export default nextConfig
