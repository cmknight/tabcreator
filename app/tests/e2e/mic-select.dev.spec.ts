import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import {
  countGetUserMedia,
  expectNoSeriousAxe,
  goLive,
  gumCalls,
  gumLog,
  meter,
} from './mic-helpers';

// Runs in the `dev` project only: each `?fakeMic` fixture is one fake input device (story 2.2),
// id `fake-mic-<fixture>`, label "Fake mic: <fixture>". open_strings moves the meter; silence_60s
// keeps it at −60.

const OPEN = 'fake-mic-open_strings';
const SILENCE = 'fake-mic-silence_60s';
const OPEN_LABEL = 'Fake mic: open_strings';
const SILENCE_LABEL = 'Fake mic: silence_60s';
const LOST_TITLE = 'Microphone access was lost';

const select = (page: Page) => page.getByRole('combobox', { name: 'Microphone' });
const toast = (page: Page) => page.getByTestId('toast');
const lostCard = (page: Page) => page.getByRole('region', { name: LOST_TITLE });

const storedPrefs = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tabcreator.prefs.v1') ?? 'null'));

/**
 * Opens Record with `fixtures` as the devices and goes live with Allow, counting and logging
 * every `getUserMedia` call.
 */
async function goLiveLogged(page: Page, fixtures: string): Promise<string[]> {
  await countGetUserMedia(page);
  return goLive(page, fixtures);
}

/** The meter's reading moves away from −60 (open_strings is playing). */
async function expectMeterMoving(page: Page) {
  await expect
    .poll(async () => Number(await meter(page).getAttribute('aria-valuenow')))
    .not.toBe(-60);
}

test('one device: no select', async ({ page }) => {
  const errors = await goLiveLogged(page, 'open_strings');
  await page.waitForTimeout(300);
  await expect(select(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('two devices: the select lists both labels with the live one selected; passes axe', async ({
  page,
}) => {
  const errors = await goLiveLogged(page, 'open_strings,silence_60s');
  await expect(select(page)).toBeVisible();
  await expect(select(page).locator('option')).toHaveText([OPEN_LABEL, SILENCE_LABEL]);
  await expect(select(page)).toHaveValue(OPEN);
  // The select comes before the meter, as in the mockup.
  const order = await page.evaluate(() => {
    const s = document.querySelector('select')!;
    const m = document.querySelector('[role="meter"]')!;
    return s.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('switch: old tracks stop before one exact request, and the meter follows', async ({
  page,
}) => {
  const errors = await goLiveLogged(page, 'open_strings,silence_60s');
  await expectMeterMoving(page);
  expect(await gumCalls(page)).toBe(1);

  await select(page).focus();
  await select(page).selectOption(SILENCE);
  await expect(select(page)).toHaveValue(SILENCE);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  // The meter drops to −60 as soon as the old input closes, before the new one opens; the switch
  // is done (and a next choice accepted) once the device is saved.
  await expect.poll(async () => (await storedPrefs(page)).micDeviceId).toBe(SILENCE);
  expect(await gumCalls(page)).toBe(2);
  expect((await gumLog(page))[1]).toEqual({
    deviceId: JSON.stringify({ exact: SILENCE }),
    liveBefore: 0,
  });
  // The select keeps focus through the switch.
  await expect(select(page)).toBeFocused();

  await select(page).selectOption(OPEN);
  await expectMeterMoving(page);
  expect(await gumCalls(page)).toBe(3);
  expect((await gumLog(page))[2]).toEqual({
    deviceId: JSON.stringify({ exact: OPEN }),
    liveBefore: 0,
  });
  expect(errors).toEqual([]);
});

test('remember: after a reload with the permission granted the chosen device is live again', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['microphone']);
  const errors = await goLiveLogged(page, 'open_strings,silence_60s');
  await select(page).selectOption(SILENCE);
  // Saved once the new device is open.
  await expect.poll(async () => (await storedPrefs(page)).micDeviceId).toBe(SILENCE);

  await page.reload();
  await expect(meter(page)).toBeVisible();
  await expect(select(page)).toHaveValue(SILENCE);
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  await page.waitForTimeout(300);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('saved device gone: the default opens and micDeviceId is cleared', async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await context.grantPermissions(['microphone']);
  await page.goto('./?fakeMic=open_strings,silence_60s#/record');
  await page.evaluate(() =>
    localStorage.setItem(
      'tabcreator.prefs.v1',
      JSON.stringify({ version: 1, micGranted: true, micDeviceId: 'fake-mic-unplugged' }),
    ),
  );
  await page.reload();
  await expect(meter(page)).toBeVisible();
  await expect(select(page)).toHaveValue(OPEN);
  await expect.poll(async () => (await storedPrefs(page)).micDeviceId).toBeNull();
  await expect(lostCard(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('unplug of the active device with another left: switches with a toast, no lost card', async ({
  page,
}) => {
  const errors = await goLiveLogged(page, 'open_strings,silence_60s');
  await expect(select(page)).toHaveValue(OPEN);
  await page.evaluate((id) => window.__fakeMic!.unplug(id), OPEN);

  await expect(toast(page)).toHaveText(`Microphone disconnected — switched to ${SILENCE_LABEL}`);
  await expect(page.locator('[aria-live="polite"]')).toHaveText(
    `Microphone disconnected — switched to ${SILENCE_LABEL}`,
  );
  await expect(meter(page)).toBeVisible();
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  await expect(lostCard(page)).toHaveCount(0);
  // One device left: the select hides.
  await expect(select(page)).toHaveCount(0);
  // The fallback is one default request, made after the unplugged track had ended.
  await expect
    .poll(async () => (await gumLog(page)).map((c) => c.deviceId))
    .toEqual(['null', 'null']);
  expect((await gumLog(page))[1]).toEqual({ deviceId: 'null', liveBefore: 0 });
  expect(await gumCalls(page)).toBe(2);
  expect(errors).toEqual([]);
});

test('unplug of the only device: the lost card, no toast', async ({ page }) => {
  const errors = await goLiveLogged(page, 'open_strings');
  await page.evaluate((id) => window.__fakeMic!.unplug(id), OPEN);
  await expect(lostCard(page)).toBeVisible();
  // The card is the end state; a late fallback would still show here as a second request.
  await page.waitForTimeout(300);
  await expect(toast(page)).toHaveCount(0);
  expect((await gumLog(page)).map((c) => c.deviceId)).toEqual(['null']);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('revoke with devices still listed: the lost card, no toast', async ({ page }) => {
  const errors = await goLiveLogged(page, 'open_strings,silence_60s');
  await page.evaluate(() => window.__fakeMic!.revoke());
  await expect(lostCard(page)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(toast(page)).toHaveCount(0);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('a device list change while live refreshes the select', async ({ page }) => {
  const errors = await goLiveLogged(page, 'open_strings,silence_60s');
  await expect(select(page).locator('option')).toHaveText([OPEN_LABEL, SILENCE_LABEL]);
  await page.evaluate(
    (id) => window.__fakeMic!.configure(id, { label: 'USB Audio CODEC' }),
    SILENCE,
  );
  await expect(select(page).locator('option')).toHaveText([OPEN_LABEL, 'USB Audio CODEC']);
  await expect(select(page)).toHaveValue(OPEN);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});
