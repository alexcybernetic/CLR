import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const host = '127.0.0.1';
const port = 4173;
const baseURL = `http://${host}:${port}`;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: fileURLToPath(new URL('./browser', import.meta.url)),
  outputDir: fileURLToPath(new URL('./test-results', import.meta.url)),
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1600, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Browser checks exercise Vite's production output, not the development
    // transform pipeline. The caller builds appweb/dist before Playwright.
    command: `npm run preview -- --host ${host} --port ${port} --strictPort`,
    cwd: repoRoot,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
