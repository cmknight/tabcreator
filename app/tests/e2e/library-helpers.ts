import type { Locator, Page } from '@playwright/test';

// The Library screen's locators, shared by the Library, backup, restore, storage-states and
// search-latency specs.

/** The Library's heading. */
export const heading = (page: Page): Locator =>
  page.getByRole('heading', { level: 1, name: 'Library' });

/** The list of takes. */
export const list = (page: Page): Locator =>
  page.getByRole('list', { name: 'Takes, newest first' });

/** The take's row. */
export const row = (page: Page, id: string): Locator =>
  list(page).locator(`li[data-take-id="${id}"]`);

/** A link of the main navigation, by its exact name. */
export const nav = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

/** The Library header: the row of tools holding the search field and the backup buttons. */
const header = (page: Page): Locator => page.getByRole('search').locator('..');

/** The header's Back up library (not the one-time storage notice's, story 6.7). */
export const backupButton = (page: Page): Locator =>
  header(page).getByRole('button', { name: 'Back up library' });

/** The header's Restore from backup (Restoring… while a restore runs). */
export const restoreButton = (page: Page): Locator =>
  header(page).getByRole('button', { name: /^(Restore from backup|Restoring…)$/ });
