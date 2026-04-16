import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Empty turbopack config to silence the warning
  turbopack: {},
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'ALLOW-FROM https://ringcx.ringcentral.com',
          },
          {
            key: 'Content-Security-Policy',
            value: 'frame-ancestors https://ringcx.ringcentral.com',
          },
        ],
      },
    ]
  },
};

export default nextConfig;
