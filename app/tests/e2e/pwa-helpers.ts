import { expect, type Page } from '@playwright/test';

// The installable, offline app (story "Installable offline app", CAP-20, spine AD-19), checked
// through Chrome's own view of it over CDP, not Lighthouse.

/** What Chrome made of the page's web manifest: its URL, parse errors and parsed JSON. */
export async function appManifest(page: Page): Promise<{
  url: string;
  errors: string[];
  manifest: Record<string, unknown>;
}> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { url, errors, data } = (await cdp.send('Page.getAppManifest')) as {
      url: string;
      errors: { message: string }[];
      data?: string;
    };
    return {
      url,
      errors: errors.map((e) => e.message),
      manifest: data ? (JSON.parse(data) as Record<string, unknown>) : {},
    };
  } finally {
    await cdp.detach();
  }
}

/** Chrome's installability errors for the page (none: the app can be installed). */
export async function installabilityErrors(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: {
        errorId: string;
        errorArguments: { name: string; value: string }[];
      }[];
    };
    return installabilityErrors.map(
      (e) => `${e.errorId}${e.errorArguments.map((a) => ` ${a.name}=${a.value}`).join('')}`,
    );
  } finally {
    await cdp.detach();
  }
}

/**
 * Waits for the service worker to be active and controlling the page (`clientsClaim`, so on the
 * first visit too, with no reload); returns its script URL and scope.
 */
export async function waitForController(page: Page): Promise<{ script: string; scope: string }> {
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .not.toBeNull();
  const script = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
  return { script, scope };
}
