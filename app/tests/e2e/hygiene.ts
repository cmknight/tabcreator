import { expect, type Page } from '@playwright/test';

/**
 * Watches a page for CSP violations, "Refused to" console errors, failed requests and
 * requests off the page's origin (spine AD-13). Call before the first `goto`; call the
 * returned `expectClean` at the end of the test.
 */
export async function watchHygiene(page: Page, baseURL: string) {
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
  page.context().on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.context().on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });

  return {
    expectClean() {
      expect(violations).toEqual([]);
      expect(refused).toEqual([]);
      expect(failed).toEqual([]);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.filter((u) => new URL(u).origin !== origin)).toEqual([]);
    },
  };
}
