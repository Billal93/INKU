// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: /studio\.spec\.js/,   // suite du Studio : playwright.studio.config.js (Chrome/Edge installés)
  timeout: 30000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8731',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python -m http.server 8731',
    url: 'http://localhost:8731/index.html',
    reuseExistingServer: true,
    timeout: 20000,
  },
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'Desktop Firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'Desktop Safari', use: { ...devices['Desktop Safari'] } },
    { name: 'iPhone SE (Safari)', use: { ...devices['iPhone SE'] } },
    { name: 'iPhone 14 (Safari)', use: { ...devices['iPhone 14'] } },
    { name: 'iPad (Safari)', use: { ...devices['iPad (gen 7)'] } },
    { name: 'Pixel 7 (Chrome)', use: { ...devices['Pixel 7'] } },
    { name: 'Galaxy S9+ (Chrome)', use: { ...devices['Galaxy S9+'] } },
  ],
});
