import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',              // Generate pure static HTML/JS/CSS to out/
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true }, // No image optimization server needed
};

export default nextConfig;
