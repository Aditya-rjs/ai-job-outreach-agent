import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exclude native and node-specific modules from webpack bundling
  serverExternalPackages: ['better-sqlite3', 'pdf-parse', 'xlsx'],
};

export default nextConfig;
