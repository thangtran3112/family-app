import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
  transpilePackages: ["@ai-trading/contracts"],
};

export default nextConfig;
