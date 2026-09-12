import type { NextConfig } from "next";

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const NO_STORE_HEADERS = [{ key: "Cache-Control", value: "no-store" }];

export default {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: NO_STORE_HEADERS },
      {
        source: "/:path((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
        headers: NO_STORE_HEADERS,
      },
    ];
  },
} satisfies NextConfig;
