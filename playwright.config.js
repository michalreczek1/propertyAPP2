'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8090',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node scripts/playwright-server.js',
    url: 'http://127.0.0.1:8090/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
