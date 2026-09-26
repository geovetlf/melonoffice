import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test for a deployed web service. It runs against SMOKE_BASE_URL (for example the dev
 * Cloud Run URL) and is not part of `pnpm test`.
 */
const baseURL = process.env['SMOKE_BASE_URL'];
if (!baseURL) {
  throw new Error('Set SMOKE_BASE_URL to the URL of the deployed web service.');
}
const executablePath = process.env['SMOKE_CHROMIUM_PATH'];

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  retries: 1,
  reporter: 'list',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
  },
});
