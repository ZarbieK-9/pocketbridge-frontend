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
    // Treat this folder (pocketbridge) as the workspace root
    root: '.',
  },
  // Note: For full PWA support in production, integrate next-pwa or workbox.
};

export default nextConfig
