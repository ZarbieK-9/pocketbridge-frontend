import path from 'path';
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // Enforce type validation during builds
    ignoreBuildErrors: false,
  },
  images: {
    // No image optimization on server (use external/CDN if needed)
    unoptimized: true,
  },
  turbopack: {
    // Absolute path to the workspace root to silence informational note
    root: path.resolve(process.cwd()),
  },
  // Note: For full PWA support in production, integrate next-pwa or workbox.
};

export default nextConfig
