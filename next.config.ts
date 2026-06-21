import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon; keep it external so it isn't bundled.
  serverExternalPackages: ["better-sqlite3"],
  // Build a self-contained server bundle for the Docker image.
  output: "standalone",
};

export default nextConfig;
