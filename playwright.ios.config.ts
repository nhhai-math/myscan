import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

const baseURL = 'http://127.0.0.1:3102/myscan/ios/';
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browserName = process.env.MYSCAN_IOS_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
process.env.XDG_CACHE_HOME ||= '/workspace/.cache/ios-browser';
mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });

export default defineConfig({
  testDir: './test/ios',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL,
    browserName,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    launchOptions: browserName === 'chromium' ? { executablePath: chromiumPath } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  outputDir: './test-results/ios',
  webServer: {
    command: 'node scripts/build-ios-pwa.mjs --local-only && node scripts/serve-ios-test.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
