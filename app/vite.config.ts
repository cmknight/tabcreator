/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaIcons, pwaManifest } from './build/pwa-icons.ts';
import { themeBoot } from './build/theme-boot.ts';

/**
 * The production Content-Security-Policy (spine AD-13). Exported for the e2e tests, which
 * check the built `index.html` carries exactly this.
 */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self'";

/** Adds the CSP meta tag to production builds only: the dev server needs inline scripts (HMR). */
function cspMeta(): Plugin {
  const charset = /<meta charset="UTF-8" \/>/;
  return {
    name: 'tabcreator-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      // Right after the charset (which must come first) and before any script.
      if (!charset.test(html)) throw new Error('index.html: no <meta charset> to anchor the CSP');
      return html.replace(
        charset,
        (m) => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

/**
 * The e2e update test's second build (story "Update available prompt"): with
 * `TABCREATOR_E2E_BUILD=B` the build is a new version of the app (its `index.html`, and so its
 * service worker's precache manifest, differ) and goes to `dist-update/`, never `dist/`.
 */
const E2E_BUILD = process.env.TABCREATOR_E2E_BUILD;

/** Marks the e2e second build's `index.html` with `<meta name="tabcreator-build">`. */
function e2eBuildMeta(build: string | undefined): Plugin {
  return {
    name: 'tabcreator-e2e-build-meta',
    apply: 'build',
    transformIndexHtml(html) {
      if (!build) return html;
      if (!/^[A-Za-z0-9]+$/.test(build)) throw new Error(`TABCREATOR_E2E_BUILD: bad ${build}`);
      return html.replace(
        '</head>',
        `  <meta name="tabcreator-build" content="${build}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    cspMeta(),
    // The theme pref applied before the first paint (story "Theme toggle"): build/theme-boot.ts.
    themeBoot(),
    e2eBuildMeta(E2E_BUILD),
    pwaIcons(),
    // The installable, offline app (CAP-20, spine AD-19). Production builds only: the dev server
    // gets the plugin's no-op `virtual:pwa-register` stub and no service worker.
    VitePWA({
      // A new version waits for the player's say-so (the update toast, a later story).
      registerType: 'prompt',
      // main.tsx registers through `virtual:pwa-register` (bundled, external code): the plugin's
      // inline or extra registration script is not needed, and inline script breaks the CSP.
      injectRegister: false,
      // From the theme tokens (AD-12); start_url, scope and id relative, like `base`.
      manifest: pwaManifest(),
      workbox: {
        // The shell, every JS chunk (workers and the recorder worklet included), the CSS, the
        // engine wasm, the icons (emitted by pwaIcons) and theme-boot.js (themeBoot). The manifest
        // is added by the plugin.
        globPatterns: ['**/*.{js,wasm,css,html,png,svg}'],
        // The first visit is controlled without a reload, so it works offline straight away.
        // No skipWaiting: an update waits (registerType 'prompt').
        clientsClaim: true,
      },
    }),
  ],
  // Relative asset URLs, so the build works from any sub-path (e.g. GitHub Pages' /tabcreator/).
  base: './',
  build: {
    // No data: URIs; every asset is a same-origin file the CSP allows (spine AD-13).
    assetsInlineLimit: 0,
    // dist/.vite/manifest.json, read by build/size-budget.ts (the initial JS budget, spine AD-17).
    // Not precached: the PWA glob has no json.
    manifest: true,
    ...(E2E_BUILD ? { outDir: 'dist-update' } : {}),
  },
  // The engine worker loads the wasm glue with a dynamic import, which needs an ES module worker.
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    // Unit tests live in tests/unit/ only. src/lint-rules.test.ts is the one exception, by
    // design: it tests eslint.config.js's layer rules against fixture paths inside src/.
    include: ['tests/unit/**/*.test.{ts,tsx}', 'src/lint-rules.test.ts'],
  },
});
