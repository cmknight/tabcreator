import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const DEV_PORT = 5174;
const SUBPATH_PORT = 4174;

/** Specs that need dev-only code (`#/__test/*` pages) run against the dev server only. */
const DEV_SPECS = /.*\.dev\.spec\.ts/;
/** The sub-path spec runs against the build served under /tabcreator/, as on GitHub Pages. */
const SUBPATH_SPECS = /.*subpath\.spec\.ts/;

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
      testIgnore: [DEV_SPECS, SUBPATH_SPECS],
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}/` },
    },
    {
      name: 'subpath',
      testMatch: SUBPATH_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${SUBPATH_PORT}/tabcreator/`,
      },
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
      // The same dist/ under /tabcreator/. Starts after the build above (web servers start in
      // order), and reads dist/ per request.
      command: `node tests/e2e/serve-subpath.ts ${SUBPATH_PORT}`,
      url: `http://localhost:${SUBPATH_PORT}/tabcreator/`,
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
