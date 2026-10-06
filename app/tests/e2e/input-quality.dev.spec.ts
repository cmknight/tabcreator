import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expectNoSeriousAxe, goLive, meter } from './mic-helpers';

// Runs in the `dev` project only: each `?fakeMic` fixture is one fake input device (story 2.2),
// id `fake-mic-<fixture>`, 48 kHz. `configure(id, { sampleRate, label })` applies to streams
// opened afterwards; a label change fires `devicechange`.

const OPEN = 'fake-mic-open_strings';
const SILENCE = 'fake-mic-silence_60s';
const WARNING =
  'This microphone may be a Bluetooth headset in call mode — accuracy will be poor. Use the built-in or a wired mic.';
const DISMISS_NAME = 'Dismiss Bluetooth warning for this session';

const banner = (page: Page) => page.getByTestId('input-quality-banner');
const dismiss = (page: Page) => page.getByRole('button', { name: DISMISS_NAME });
const select = (page: Page) => page.getByRole('combobox', { name: 'Microphone' });

type Options = { sampleRate?: number; label?: string };

/** Configures fake devices; call once the fake mic is installed and before the mic opens. */
async function configure(page: Page, devices: Record<string, Options>): Promise<void> {
  await page.evaluate((all) => {
    for (const [id, options] of Object.entries(all)) window.__fakeMic!.configure(id, options);
  }, devices);
}

/** Opens Record with `fixtures`, configures the devices, then goes live with Allow. */
function goLiveWith(
  page: Page,
  fixtures: string,
  devices: Record<string, Options> = {},
): Promise<string[]> {
  return goLive(page, fixtures, { before: () => configure(page, devices) });
}

test('normal input: no banner', async ({ page }) => {
  const errors = await goLiveWith(page, 'open_strings');
  await page.waitForTimeout(300);
  await expect(banner(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('low rate: the banner shows above the h1, is announced politely and passes axe', async ({
  page,
}) => {
  const errors = await goLiveWith(page, 'open_strings', { [OPEN]: { sampleRate: 16000 } });
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(WARNING);
  await expect(dismiss(page)).toHaveText('Dismiss');
  // The banner itself is not a live region; the shared announcer speaks it.
  await expect(banner(page)).not.toHaveAttribute('aria-live');
  await expect(banner(page)).not.toHaveAttribute('role');
  await expect(page.locator('[aria-live="polite"]')).toHaveText(WARNING);
  const before = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="input-quality-banner"]')!;
    const h1 = document.querySelector('h1')!;
    return Boolean(b.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('dark mode: Record with the banner passes axe', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const errors = await goLiveWith(page, 'open_strings', { [OPEN]: { sampleRate: 16000 } });
  await expect(banner(page)).toBeVisible();
  // The dark tokens are in force, so axe's contrast check sees the dark colours.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
    'dark',
  );
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('returning to Record while the banner shows announces it again', async ({ page }) => {
  const errors = await goLiveWith(page, 'open_strings', { [OPEN]: { sampleRate: 16000 } });
  const polite = page.locator('[aria-live="polite"]');
  await expect(polite).toHaveText(WARNING);
  // Clear the region, so only a new announcement can fill it again.
  await page.evaluate(() => {
    document.querySelector('[aria-live="polite"]')!.textContent = '';
  });
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await expect(polite).toHaveText('');
  await page.getByRole('navigation').getByRole('link', { name: 'Record' }).click();
  await expect(banner(page)).toBeVisible();
  await expect(polite).toHaveText(WARNING);
  expect(errors).toEqual([]);
});

test('headset label: the banner shows', async ({ page }) => {
  const errors = await goLiveWith(page, 'open_strings', { [OPEN]: { label: 'AirPods Pro' } });
  await expect(banner(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('switch away from a poor input: the banner goes', async ({ page }) => {
  const errors = await goLiveWith(page, 'open_strings,silence_60s', {
    [OPEN]: { label: 'AirPods Pro' },
  });
  await expect(banner(page)).toBeVisible();
  await select(page).selectOption(SILENCE);
  await expect(select(page)).toHaveValue(SILENCE);
  await expect(banner(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('relabelled live to a headset: the banner shows after the devicechange', async ({ page }) => {
  const errors = await goLiveWith(page, 'open_strings');
  await page.waitForTimeout(300);
  await expect(banner(page)).toHaveCount(0);
  await configure(page, { [OPEN]: { label: 'Headset' } });
  await expect(banner(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('Dismiss hides it for the session, also after switching to another poor input', async ({
  page,
}) => {
  const errors = await goLiveWith(page, 'open_strings,silence_60s', {
    [OPEN]: { label: 'AirPods Pro' },
    [SILENCE]: { sampleRate: 16000 },
  });
  await expect(banner(page)).toBeVisible();
  // By keyboard: focus moves to the heading, not to <body>, as the button goes.
  await dismiss(page).focus();
  await page.keyboard.press('Enter');
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Record' })).toBeFocused();

  await select(page).selectOption(SILENCE);
  await expect(select(page)).toHaveValue(SILENCE);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  await page.waitForTimeout(300);
  await expect(banner(page)).toHaveCount(0);
  // Nothing about the dismissal is saved.
  const prefs = await page.evaluate(() => localStorage.getItem('tabcreator.prefs.v1') ?? '');
  expect(prefs).not.toMatch(/dismiss|quality/i);
  expect(errors).toEqual([]);
});

test('reload after Dismiss: the banner shows again while the condition holds', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['microphone']);
  const errors = await goLiveWith(page, 'open_strings', { [OPEN]: { sampleRate: 16000 } });
  await expect(banner(page)).toBeVisible();
  await dismiss(page).click();
  await expect(banner(page)).toHaveCount(0);

  // The fake mic's configuration does not survive a reload: reload on Library, configure the
  // device again, then enter Record, which reopens the granted mic without a click.
  // (A goto that changes only the hash would not reload the page.)
  await page.getByRole('link', { name: 'Library' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await configure(page, { [OPEN]: { sampleRate: 16000 } });
  await page.getByRole('navigation').getByRole('link', { name: 'Record' }).click();
  await expect(meter(page)).toBeVisible();
  await expect(banner(page)).toBeVisible();
  expect(errors).toEqual([]);
});

declare global {
  interface Window {
    __politeLog?: string[];
  }
}

/** Logs every non-empty text the shared polite live region takes, in order. */
async function logPolite(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: string[] = [];
    window.__politeLog = log;
    const region = document.querySelector('[aria-live="polite"]')!;
    new MutationObserver(() => {
      const said = region.textContent ?? '';
      if (said) log.push(said);
    }).observe(region, { subtree: true, childList: true, characterData: true });
  });
}

const politeLog = (page: Page) => page.evaluate(() => window.__politeLog ?? []);

test('unplug onto a headset: the switch toast and the warning are both announced, in order', async ({
  page,
}) => {
  const errors = await goLiveWith(page, 'open_strings,silence_60s', {
    [SILENCE]: { label: 'AirPods Pro' },
  });
  await expect(banner(page)).toHaveCount(0);
  await logPolite(page);
  await page.evaluate((id) => window.__fakeMic!.unplug(id), OPEN);
  const switched = 'Microphone disconnected — switched to AirPods Pro';
  await expect(page.getByTestId('toast')).toHaveText(switched);
  await expect(banner(page)).toBeVisible();
  // Both reach the region, each once, neither replacing the other unspoken. They are announced
  // in one commit, the banner's effect first (it comes before the shell's toast host in the
  // tree), and spoken in that order.
  const pair = async () =>
    (await politeLog(page)).filter((said) => said === switched || said === WARNING);
  await expect.poll(pair).toEqual([WARNING, switched]);
  expect(errors).toEqual([]);
});

test('Tuner at 16 kHz: the banner shows above the Tuner h1, is announced, and Dismiss focuses the h1', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./?fakeMic=open_strings#/tuner');
  const allow = page.getByRole('button', { name: 'Allow microphone' });
  await expect(allow).toBeVisible();
  await configure(page, { [OPEN]: { sampleRate: 16000 } });
  await logPolite(page);
  await allow.click();
  await expect(meter(page)).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(WARNING);
  const h1 = page.getByRole('heading', { level: 1, name: 'Tuner' });
  const before = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="input-quality-banner"]')!;
    const h = document.querySelector('h1')!;
    return Boolean(b.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  await expect.poll(() => politeLog(page)).toContain(WARNING);
  // By keyboard: focus moves to the Tuner heading as the button goes.
  await dismiss(page).focus();
  await page.keyboard.press('Enter');
  await expect(banner(page)).toHaveCount(0);
  await expect(h1).toBeFocused();
  expect(errors).toEqual([]);
});
