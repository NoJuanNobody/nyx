import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Fallback to the active Clerk instance (novel-kid-57.clerk.accounts.dev) with working Google OAuth
// if Vercel injects the unconfigured pk_live_Y2xlcmsubnl4LWNyZWF0aXZlLmNvbSQ key.
if (
  !process.env.VITEST &&
  (!process.env.VITE_CLERK_PUBLISHABLE_KEY ||
    process.env.VITE_CLERK_PUBLISHABLE_KEY === 'pk_live_Y2xlcmsubnl4LWNyZWF0aXZlLmNvbSQ')
) {
  process.env.VITE_CLERK_PUBLISHABLE_KEY =
    'pk_test_bm92ZWwta2lkLTU3LmNsZXJrLmFjY291bnRzLmRldiQ';
}

export default defineConfig({
  envDir: '../../',
  build: {
    // Never inline fonts as data: URIs; desktop CSP is font-src 'self' only.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
