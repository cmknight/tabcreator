import type { Locator, Page } from '@playwright/test';

/** The compressed audio type every saved take uses (`Take.audioMime`). */
export const MIME = 'audio/webm;codecs=opus';

/**
 * What Playwright itself logs when a test's `serviceWorkers: 'block'` refuses the app's service
 * worker registration (engine.spec.ts): the harness, not the app.
 */
const SW_BLOCKED = /^Service Worker registration blocked by Playwright/;

/** Collects console errors and warnings plus uncaught page errors. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if ((msg.type() === 'error' || msg.type() === 'warning') && !SW_BLOCKED.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** The decoded duration (s) of the take's compressed webm; null when missing or undecodable. */
export function decodedSeconds(page: Page, id: string): Promise<number | null> {
  return page.evaluate(async (takeId) => {
    try {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getDirectoryHandle('audio')).getFileHandle(`${takeId}.webm`);
      const ctx = new OfflineAudioContext(1, 1, 48_000);
      const buffer = await ctx.decodeAudioData(await (await file.getFile()).arrayBuffer());
      return buffer.duration;
    } catch {
      return null;
    }
  }, id);
}

/** Record's Record button (`exact`, so not "Record" inside another name). */
export const recordButton = (page: Page) =>
  page.getByRole('button', { name: 'Record', exact: true });

/** Record's Stop button. */
export const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

/** Record's elapsed-time readout. */
export const timer = (page: Page) => page.getByRole('timer');

/** The announcer's polite region (not the Library's storage notice, also role status). */
export const politeRegion = (page: Page): Locator =>
  page.locator('[role="status"][aria-live="polite"]');

declare global {
  interface Window {
    __liveLog?: { polite: string[]; assertive: string[] };
  }
}

/**
 * Logs every non-empty text each shared live region takes, in order (read with `liveLog`); the
 * regions must be on the page.
 */
export async function logLive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log = { polite: [] as string[], assertive: [] as string[] };
    window.__liveLog = log;
    for (const kind of ['polite', 'assertive'] as const) {
      const region = document.querySelector(`[aria-live="${kind}"]`)!;
      new MutationObserver(() => {
        const said = region.textContent ?? '';
        if (said) log[kind].push(said);
      }).observe(region, { subtree: true, childList: true, characterData: true });
    }
  });
}

export const liveLog = (page: Page) =>
  page.evaluate(() => window.__liveLog ?? { polite: [], assertive: [] });
