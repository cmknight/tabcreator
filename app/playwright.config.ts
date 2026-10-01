import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const DEV_PORT = 5174;

/** Specs that need dev-only code (`#/__test/*` pages) run against the dev server only. */
const DEV_SPECS = /.*\.dev\.spec\.ts/;

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: DEV_SPECS,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}/` },
    },
    {
      name: 'dev',
      testMatch: DEV_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${DEV_PORT}/`,
        // The fake mic (US-0.4) plays through an AudioContext started without a user gesture.
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
  webServer: [
    {
      // Builds the engine wasm (so Rust edits are never served stale) and the app, then serves
      // the production bundle with `vite preview`.
      // Preview runs through the package bin, not `pnpm exec`: pnpm starts its child in a
      // separate process group, which Playwright's shutdown would leave running.
      command: `pnpm -w run build:engine && pnpm exec vite build && node_modules/.bin/vite preview --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // The dev server, for dev-only test pages. Same package-bin rule as above.
      command: `node_modules/.bin/vite --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
