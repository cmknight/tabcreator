import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';

// The Tab screen's Copy and Download, for the export specs (story "Copy and Download on the Tab
// screen", CAP-18) and the offline flow. Copy needs the context's
// `grantPermissions(['clipboard-read', 'clipboard-write'])`.

/** A button in the Tab screen's toolbar. */
export const toolButton = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: 'Tab tools' }).getByRole('button', { name, exact: true });

/** The toast. */
export const toast = (page: Page) => page.getByTestId('toast');

/** The clipboard's text. */
export const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/**
 * Whether the page reports Windows (ui/platform.ts `isWindowsPlatform`). Downloads use `\r\n`
 * there; export.spec.ts forces each platform with an init script (`reportPlatform`).
 */
export const windows = (page: Page) =>
  page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /^win/i.test(nav.userAgentData?.platform || nav.platform || '');
  });

/**
 * Clicks Download; returns the file's suggested name and its text with `\n` line endings,
 * having checked the file's own endings: `\r\n` on Windows only (CAP-18).
 */
export async function download(page: Page): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    toolButton(page, 'Download').click(),
  ]);
  const raw = await readFile(await file.path(), 'utf8');
  const crlf = await windows(page);
  if (crlf) expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  else expect(raw).not.toContain('\r');
  return { name: file.suggestedFilename(), text: crlf ? raw.replace(/\r\n/g, '\n') : raw };
}

/** Clicks Copy, waits for "Tab copied"; returns the clipboard's text. */
export async function copy(page: Page): Promise<string> {
  await toolButton(page, 'Copy').click();
  await expect(toast(page)).toHaveText('Tab copied');
  return clipboard(page);
}
