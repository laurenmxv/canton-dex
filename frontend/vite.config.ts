/// <reference types="vitest/config" />
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
  plugins: [react(), cantonSnapServer()],
  server: { port: 5180, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    // An origin is what gives jsdom a working localStorage.
    environmentOptions: { jsdom: { url: 'http://localhost:5180/' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Ledger confirmations arrive over several polls, so flows need headroom.
    testTimeout: 20_000,
  },
});
