import { defineConfig } from '@playwright/test';

const externalBaseURL = process.env.MYOTA_BROWSER_BASE_URL;

export default defineConfig({
  testDir: './web',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:8090',
    browserName: 'chromium',
  },
  webServer: externalBaseURL
    ? []
    : [
        ...(process.env.CORE_DATABASE_URL &&
        process.env.ACTIVITY_DATABASE_URL &&
        process.env.GEO_DATABASE_URL
          ? [
              {
                command: 'node tools/run-browser-api-stack.mjs',
                url: 'http://127.0.0.1:18080/readyz',
                reuseExistingServer: !process.env.CI,
                timeout: 90_000,
              },
            ]
          : []),
        {
          command: 'npm run dev --prefix web/admin -- --host 127.0.0.1',
          url: 'http://127.0.0.1:8090',
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
        {
          command:
            './node_modules/.bin/vite web/participant/web --config web/participant/vite.config.mjs --host 127.0.0.1 --port 8091 --strictPort',
          url: 'http://127.0.0.1:8091',
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      ],
});
