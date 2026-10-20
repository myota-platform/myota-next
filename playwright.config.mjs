import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './web',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8090',
    browserName: 'chromium',
  },
  webServer: [
    {
      command: 'npm run dev --prefix web/admin -- --host 127.0.0.1',
      url: 'http://127.0.0.1:8090',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command:
        './node_modules/.bin/vite web/participant/web --host 127.0.0.1 --port 8091 --strictPort',
      url: 'http://127.0.0.1:8091',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
