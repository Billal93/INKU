// Tests du Studio : navigateurs installés (Chrome/Edge) car ils décodent/encodent le H.264 via WebCodecs.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /studio\.spec\.js/,
  timeout: 180000,
  workers: 1,
  reporter: [['list']],
  webServer: { command: 'python -m http.server 8731', url: 'http://localhost:8731/montage/studio.html', reuseExistingServer: true, timeout: 20000 },
});
