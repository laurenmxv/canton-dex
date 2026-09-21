/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cantonSnapServer } from './dev/cantonSnap';

/**
 * The venue API, proxied under `/api` so the browser stays same-origin and the
 * backend needs no CORS rule. `DEX_API_ORIGIN` points it somewhere else.
 */
const apiProxy = {
  '/api': {
    target: process.env['DEX_API_ORIGIN'] ?? 'http://localhost:18080',
    // Keep the browser's Host header, and strip the prefix so the backend sees
    // the `/v1` paths it actually routes.
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [tailwindcss(), react(), cantonSnapServer()],
  // Treat the SDK as source so edits participate in Vite's normal HMR graph.
  resolve: {
    alias: {
      '@canton-dex/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: apiProxy,
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../client', import.meta.url)),
      ],
    },
  },
  test: {
    environment: 'jsdom',
    // An origin is what gives jsdom a working localStorage.
    environmentOptions: { jsdom: { url: 'http://localhost:5180/' } },
    setupFiles: ['./src/test/setup.ts'],
    /*
     * A spy that outlives its test changes the meaning of every test after it,
     * so one real failure becomes a wall of unrelated ones.
     */
    restoreMocks: true,
    /**
     * No test reads a computed style, and jsdom lays nothing out, so the only
     * thing compiling the stylesheet buys is time: Tailwind would rebuild for
     * every test file that imports it.
     */
    css: false,
    // Ledger confirmations arrive over several polls, so flows need headroom.
    testTimeout: 20_000,
  },
});
