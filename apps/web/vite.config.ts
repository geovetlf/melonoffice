import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

/** Workspace packages are consumed from source through this export condition. */
const SOURCE_CONDITION = '@melonoffice/source';

export default defineConfig({
  plugins: [react()],
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
    server: { deps: { inline: [/@melonoffice\//] } },
  },
});
