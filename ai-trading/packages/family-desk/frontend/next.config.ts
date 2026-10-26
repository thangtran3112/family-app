import type { NextConfig } from "next";
import { resolve } from "node:path";

// The feedback form attaches this to every report ("desk-2026.10.26"): the build date, so she and the agents can tell which release she was on.
const buildDay = new Date().toISOString().slice(0, 10).replaceAll("-", ".");

const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
  turbopack: { root: resolve(process.cwd(), "..") },
  transpilePackages: ["@ai-trading/contracts"],
  env: { NEXT_PUBLIC_DESK_VERSION: `desk-${buildDay}` },
};

export default nextConfig;
