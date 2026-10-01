import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The UI is served by the Fleetbot server itself (same origin), so the strict
// CSP (script-src 'self', no inline code) applies to the production build.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    sourcemap: false,
    // No inline <script>/<style>: everything must be a same-origin file to satisfy the CSP.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    // Dev only: forward the API to `npm run dev` on :3000 without rewriting Host,
    // so the server's Origin check sees matching hosts.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
});
