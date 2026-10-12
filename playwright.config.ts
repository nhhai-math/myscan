import { defineConfig } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const baseURL = 'http://127.0.0.1:3101';
const dataDir = process.env.MYSCAN_E2E_DATA_DIR || mkdtempSync(path.join(os.tmpdir(), 'myscan-e2e-data-'));
process.env.MYSCAN_E2E_DATA_DIR = dataDir;
const cacheDir = path.join(dataDir, 'cache');
mkdirSync(cacheDir, { recursive: true });
process.env.XDG_CACHE_HOME ||= cacheDir;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: chromiumPath },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && node server/index.js --production',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { HOST: '127.0.0.1', PORT: '3101', DATA_DIR: dataDir, PUBLIC_URL: baseURL },
  },
});
