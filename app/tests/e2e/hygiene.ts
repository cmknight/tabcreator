import { expect, type Page, type Request } from '@playwright/test';

/** A failed request: the service worker's update check for `sw.js` while the network is off. */
const OFFLINE_SW_UPDATE = /\/sw\.js(\?.*)? net::ERR_INTERNET_DISCONNECTED$/;

/**
 * Watches a page for CSP violations, "Refused to" console errors, failed requests and
 * requests off the page's origin (spine AD-13). Call before the first `goto`; call the
 * returned `expectClean` at the end of the test. With `offline`, the one failure tolerated is
 * the browser's update check for the service worker script while the network is off (the
 * offline flow, story "Installable offline app").
 */
export async function watchHygiene(
  page: Page,
  baseURL: string,
  { offline = false }: { offline?: boolean } = {},
) {
  const origin = new URL(baseURL).origin;

  // Reported out of the page from its very first script, so no reload can lose one.
  const violations: string[] = [];
  await page.exposeFunction('__reportCspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    const report = (window as unknown as { __reportCspViolation: (v: string) => void })
      .__reportCspViolation;
    document.addEventListener('securitypolicyviolation', (e) => {
      void report(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const refused: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Refused to')) refused.push(msg.text());
  });
  const requests: string[] = [];
  const failed: string[] = [];
  page.context().on('request', (r) => requests.push(r.url()));
  // The service worker's own fetches (its precache install, which closing the context can
  // abort) are not the page's requests; the page's requests stay strict. Every request is still
  // checked for its origin below.
  const fromServiceWorker = (r: Request) => r.serviceWorker() !== null;
  page.context().on('requestfailed', (r) => {
    if (!fromServiceWorker(r)) failed.push(`${r.url()} ${r.failure()?.errorText}`);
  });
  page.context().on('response', (r) => {
    if (r.status() >= 400 && !fromServiceWorker(r.request()))
      failed.push(`${r.status()} ${r.url()}`);
  });

  return {
    expectClean() {
      expect(violations).toEqual([]);
      expect(refused).toEqual([]);
      expect(failed.filter((f) => !(offline && OFFLINE_SW_UPDATE.test(f)))).toEqual([]);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.filter((u) => new URL(u).origin !== origin)).toEqual([]);
    },
  };
}
