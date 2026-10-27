import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  // Trace workspace packages from the monorepo root for the standalone bundle.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../../'),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@sniper/core'],
  // The browser talks to the API through this origin, so the session cookie is first-party.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/docs', destination: `${api}/docs/` },
      { source: '/docs/:path*', destination: `${api}/docs/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;
