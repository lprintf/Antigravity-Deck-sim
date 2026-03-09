import type { NextConfig } from "next";

// Backend port: 3500 for local dev, 9807 when launched by start-tunnel.js
const BE_PORT = process.env.BACKEND_PORT || '3500';
const BE_HOST = `http://localhost:${BE_PORT}`;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false, // hide the floating Next.js "N" logo

  // Proxy /api/* and /ws/* to Express backend — works on any OS, no CORS ever
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BE_HOST}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
