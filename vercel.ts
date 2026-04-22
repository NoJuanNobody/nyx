const apiUrl = process.env.API_URL;

if (!apiUrl) {
  console.warn('Warning: API_URL is not set. The /api/* rewrite will not proxy correctly.');
}

const config = {
  framework: 'vite',
  buildCommand: 'pnpm --filter @nyx/shared build && pnpm --filter @nyx/web build',
  outputDirectory: 'apps/web/dist',
  installCommand: 'pnpm install',
  rewrites: [
    {
      source: '/api/(.*)',
      destination: `${apiUrl ?? 'http://localhost:3001'}/api/$1`,
    },
    { source: '/((?!api/).*)', destination: '/index.html' },
  ],
  headers: [
    {
      source: '/(.*)',
      headers: [
        {
          key: 'Content-Security-Policy',
          value:
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://clerk.nyx-creative.com https://accounts.nyx-creative.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.up.railway.app https://fonts.googleapis.com https://clerk.nyx-creative.com https://accounts.nyx-creative.com wss://clerk.nyx-creative.com wss://accounts.nyx-creative.com; img-src 'self' data: https:; frame-src 'self' blob: https://accounts.nyx-creative.com;",
        },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
      ],
    },
  ],
};

export default config;
