/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react(), cspMeta()],
  // Relative asset URLs, so the build works from any sub-path (e.g. GitHub Pages' /tabcreator/).
  base: './',
  build: {
    // No data: URIs; every asset is a same-origin file the CSP allows (spine AD-13).
    assetsInlineLimit: 0,
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
