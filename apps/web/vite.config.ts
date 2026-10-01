import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

/** Workspace packages are consumed from source through this export condition. */
const SOURCE_CONDITION = '@melonoffice/source';

export default defineConfig({
  plugins: [react()],
  build: {
    // Every asset is its own file, never a `data:` URI: the web server's Content-Security-Policy
    // (`nginx.conf.template`, `default-src 'self'`) refuses those, and a small picture (GIA at her
    // desk, an agent at theirs) would silently not be drawn.
    assetsInlineLimit: 0,
  },
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...defaultServerConditions],
    },
  },
  test: {
    environment: 'jsdom',
    // Whole-app tests render the office and query it by role: fast locally, slow on CI runners.
    testTimeout: 20_000,
    setupFiles: ['./src/test-setup.ts'],
    server: { deps: { inline: [/@melonoffice\//] } },
  },
});
