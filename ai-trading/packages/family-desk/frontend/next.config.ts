import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
  turbopack: { root: resolve(process.cwd(), "..") },
  transpilePackages: ["@ai-trading/contracts"],
};

export default nextConfig;
