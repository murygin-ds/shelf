import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // //go:embed resolves relative to its own package directory, so the bundle has to
    // land next to internal/web/web.go rather than inside web/.
    outDir: '../internal/web/dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Same-origin in dev, so CORS never enters the picture and the cookie-less
    // bearer flow behaves exactly as it does behind the embedded build.
    proxy: {
      // ws so the realtime socket upgrades through the dev server; without it the handshake
      // is answered by Vite rather than proxied, and only in dev.
      '/api': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
      // An MCP client reads these before it has a token, and they answer at the root rather
      // than under /api. Without the proxy the dev server hands it index.html with a 200 and
      // the connection fails with nothing to report.
      '/.well-known': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
