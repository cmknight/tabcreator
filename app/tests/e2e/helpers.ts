import type { Page } from '@playwright/test';

/** The compressed audio type every saved take uses (`Take.audioMime`). */
export const MIME = 'audio/webm;codecs=opus';

/** Collects console errors and warnings plus uncaught page errors. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
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
