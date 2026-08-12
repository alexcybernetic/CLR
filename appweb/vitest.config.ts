import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/vitest-appweb', import.meta.url)),
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: [
      'react/**/*.test.{ts,tsx}',
      'records/**/*.test.{ts,tsx}',
      'runtime/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['./react/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
