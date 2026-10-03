import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../apps/web/test',
  testMatch: '**/*.browser.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure' },
  outputDir: '../test-results/web',
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          ...(process.env.WEB_TEST_CHROMIUM_PATH
            ? { executablePath: process.env.WEB_TEST_CHROMIUM_PATH }
            : {}),
          args: ['--no-sandbox'],
        },
      },
    },
    ...(process.env.WEB_TEST_WEBKIT === 'true'
      ? [{ name: 'webkit', use: { browserName: 'webkit' as const } }]
      : []),
  ],
  webServer: {
    command: 'pnpm --filter @travel/web dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
