import type { NextConfig } from 'next';
const config: NextConfig = {
  devIndicators: false,
  transpilePackages: ['@ao/contracts'],
  experimental: { proxyClientMaxBodySize: '26mb', proxyTimeout: 125000 },
  async redirects() {
    return ['message', 'workspace', 'connection', 'calendar'].map((key) => ({
      source: '/',
      has: [{ type: 'query' as const, key }],
      destination: '/app',
      permanent: false,
    }));
  },
  async rewrites() {
    return [
      {
        source: '/.well-known/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000'}/.well-known/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000'}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default config;
