import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const DEV_PORT = 5174;
const SUBPATH_PORT = 4174;

/** Specs that need dev-only code (`#/__test/*` pages) run against the dev server only. */
const DEV_SPECS = /.*\.dev\.spec\.ts/;
/** The sub-path spec runs against the build served under /tabcreator/, as on GitHub Pages. */
const SUBPATH_SPECS = /.*subpath\.spec\.ts/;
/** Specs that need a microphone in the production build run in the production-mic lane. */
const PROD_SPECS = /.*\.prod\.spec\.ts/;

/**
 * What Chromium's fake capture device plays, looped, in the production-mic lane: a noisy C major
 * scale. Chrome's fake-audio file reader takes a PCM WAV; this one is already 16-bit PCM mono at
 * 48 kHz, so it is used as generated (tools/make_fixtures.py), with no converted copy.
 */
const MIC_FIXTURE = resolve(
  import.meta.dirname,
  '..',
  'testdata',
  'synth',
  'c_major_scale_pos1_noisy.wav',
);
// Chromium falls back to its own beep when the file is missing, silently: fail loudly instead.
if (!existsSync(MIC_FIXTURE)) throw new Error(`prod-mic fixture missing: ${MIC_FIXTURE}`);

/**
 * Locally, build the engine wasm (so Rust edits are never served stale), the test-only
 * `test-panic` engine that engine.spec.ts routes in, and the app first. In
 * CI, serve the dist/ the workflow already built, checked and uploaded for Pages, so the
 * browser tests run against exactly the published bytes.
 */
const BUILD = process.env.CI
  ? ''
  : 'pnpm -w run build:engine && pnpm -w run build:engine:test-panic && pnpm exec vite build && ';

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
      testIgnore: [DEV_SPECS, SUBPATH_SPECS, PROD_SPECS],
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}/` },
    },
    {
      // The production build with a realistic mic: Chromium's fake device plays MIC_FIXTURE, the
      // permission is granted with no prompt, and the autoplay policy is Chrome's own (no
      // override), so an AudioContext runs only after a user gesture, as for a player.
      name: 'prod-mic',
      testMatch: PROD_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${PORT}/`,
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${MIC_FIXTURE}`,
          ],
        },
      },
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
      // Serves the production bundle (built first locally, see BUILD) with `vite preview`.
      // Preview runs through the package bin, not `pnpm exec`: pnpm starts its child in a
      // separate process group, which Playwright's shutdown would leave running.
      command: `${BUILD}node_modules/.bin/vite preview --port ${PORT} --strictPort`,
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
