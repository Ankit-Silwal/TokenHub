import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.TOKENHUB_E2E === "true" ? ".next-test" : ".next",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${process.env.API_PORT || 3001}/api/:path*`,
      },
    ];
  },
};
export default config;
