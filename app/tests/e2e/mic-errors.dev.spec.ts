import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { countGetUserMedia, expectNoSeriousAxe, gumCalls, meter } from './mic-helpers';

// Runs in the `dev` project only: errors are injected through the fake mic's hooks (story 2.2).

const DEVICE = 'fake-mic-open_strings';
const SETUP_TITLE = 'TabCreator needs your microphone';

const CARDS = {
  'mic-denied': {
    title: 'Microphone access is blocked',
    body: 'Chrome is blocking the microphone for this site. To allow it:',
    steps: [
      'Click the site settings icon at the left end of the address bar.',
      'Turn on Microphone.',
      'Come back here and choose Try again.',
    ],
  },
  'mic-no-device': {
    title: 'No microphone found',
    body: "Chrome can't find a microphone. To fix it:",
    steps: [
      'Plug in a microphone or headset, or turn on your built-in mic.',
      'If your computer has a mic mute switch or key, turn it off.',
      'Come back here and choose Try again.',
    ],
  },
  'mic-in-use': {
    title: 'Your microphone is busy',
    body: 'Another app or tab is using the microphone. To free it:',
    steps: [
      'Close apps that use the mic, such as video calls.',
      'Close other browser tabs that are using the microphone.',
      'Come back here and choose Try again.',
    ],
  },
  'mic-failed': {
    title: "The microphone didn't start",
    body: 'Something went wrong opening the microphone. To fix it:',
    steps: [
      'Unplug the microphone and plug it back in.',
      "Check it works in your computer's sound settings.",
      'Come back here and choose Try again.',
    ],
  },
  'mic-lost': {
    title: 'Microphone access was lost',
    body: 'The microphone stopped or access was turned off. To get it back:',
    steps: [
      'Check the microphone is still plugged in.',
      'Check Microphone is still allowed in the site settings icon at the left end of the address bar.',
      'Choose Try again.',
    ],
  },
} as const;
type Code = keyof typeof CARDS;

/** Records every non-empty text the assertive live region takes, from page start. */
async function recordAssertive(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __assertive: string[] };
    w.__assertive = [];
    new MutationObserver(() => {
      const region = document.querySelector('[aria-live="assertive"]');
      const text = region?.textContent ?? '';
      if (text !== '' && region?.getAttribute('data-seen') !== text) {
        region?.setAttribute('data-seen', text);
        w.__assertive.push(text);
      }
      if (text === '') region?.removeAttribute('data-seen');
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const assertiveLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __assertive: string[] }).__assertive);

const card = (page: Page, code: Code) => page.getByRole('region', { name: CARDS[code].title });
const tryAgain = (page: Page) => page.getByRole('button', { name: 'Try again' });

async function open(page: Page): Promise<string[]> {
  const errors = collectErrors(page);
  await countGetUserMedia(page);
  await recordAssertive(page);
  await page.goto(`./?fakeMic=open_strings#/record`);
  await expect(page.getByRole('region', { name: SETUP_TITLE })).toBeVisible();
  return errors;
}

const failNext = (page: Page, name: string) =>
  page.evaluate((n) => window.__fakeMic!.failNext(n), name);

/** The card shows its copy verbatim, is not a live region, and its title is announced once. */
async function expectCard(page: Page, code: Code) {
  const { title, body, steps } = CARDS[code];
  const region = card(page, code);
  await expect(region).toBeVisible();
  await expect(region.getByRole('heading', { level: 2 })).toHaveText(title);
  await expect(region.getByText(body, { exact: true })).toBeVisible();
  await expect(region.getByRole('listitem')).toHaveText([...steps]);
  await expect(region.getByRole('button', { name: 'Try again' })).toBeEnabled();
  expect(await region.getAttribute('role')).toBeNull();
  expect(await region.getAttribute('aria-live')).toBeNull();
  expect(await region.locator('[aria-live], [role="alert"]').count()).toBe(0);
  await expect(page.locator('[aria-live="assertive"]')).toHaveText(title);
  await expect.poll(() => assertiveLog(page)).toEqual([title]);
  await expect(meter(page)).toHaveCount(0);
}

/** Try again opens the mic with one new call and no reload. */
async function expectTryAgainRecovers(page: Page, callsBefore: number) {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await tryAgain(page).click();
  await expect(meter(page)).toBeVisible();
  // The focused Try again is gone: focus moves to the labelled meter, not <body>.
  await expect(meter(page)).toBeFocused();
  await expect(meter(page)).toHaveAttribute('data-focus-target', '');
  expect(await gumCalls(page)).toBe(callsBefore + 1);
  expect(
    await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);
}

const REQUEST_ERRORS: [string, Code][] = [
  ['NotAllowedError', 'mic-denied'],
  ['NotFoundError', 'mic-no-device'],
  ['NotReadableError', 'mic-in-use'],
  ['TypeError', 'mic-failed'],
];

for (const [name, code] of REQUEST_ERRORS) {
  test(`${name} shows the ${code} card; Try again recovers without a reload`, async ({ page }) => {
    const errors = await open(page);
    await failNext(page, name);
    await page.getByRole('button', { name: 'Allow microphone' }).click();
    await expectCard(page, code);
    // The focused Allow button was replaced: focus moves to the error card's heading.
    await expect(card(page, code).getByRole('heading', { level: 2 })).toBeFocused();
    expect(await gumCalls(page)).toBe(1);

    // No loop: left alone, the card makes no further calls.
    await page.waitForTimeout(500);
    expect(await gumCalls(page)).toBe(1);

    await expectTryAgainRecovers(page, 1);
    expect(errors).toEqual([]);
  });
}

test('the error card passes axe', async ({ page }) => {
  const errors = await open(page);
  await failNext(page, 'NotAllowedError');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expectCard(page, 'mic-denied');
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('an error announced once is not announced again on re-entering Record', async ({ page }) => {
  const errors = await open(page);
  await failNext(page, 'NotReadableError');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expectCard(page, 'mic-in-use');
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Library' }).click();
  await nav.getByRole('link', { name: 'Record' }).click();
  await expect(card(page, 'mic-in-use')).toBeVisible();
  await page.waitForTimeout(200);
  expect(await assertiveLog(page)).toEqual([CARDS['mic-in-use'].title]);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('during a Try again the card stays with the button aria-disabled and focused', async ({
  page,
}) => {
  const errors = await open(page);
  await failNext(page, 'NotReadableError');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expectCard(page, 'mic-in-use');

  // Hold the next getUserMedia until released.
  await page.evaluate(() => {
    const md = navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    const w = window as unknown as { __release: () => void };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    w.__release = release;
    Object.defineProperty(md, 'getUserMedia', {
      value: async (c: MediaStreamConstraints) => {
        await held;
        return original(c);
      },
      configurable: true,
    });
  });
  await tryAgain(page).click();
  await expect(card(page, 'mic-in-use')).toBeVisible();
  await expect(tryAgain(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(tryAgain(page)).toBeFocused();
  // A click while requesting is ignored.
  await tryAgain(page).click({ force: true });
  expect(await gumCalls(page)).toBe(2);

  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(meter(page)).toBeVisible();
  await expect(meter(page)).toBeFocused();
  // 3, not 2: the counter also counts the hold wrapper's own call through to the fake mic.
  expect(await gumCalls(page)).toBe(3);
  expect(errors).toEqual([]);
});

test('the same failure twice is announced twice', async ({ page }) => {
  const errors = await open(page);
  const { title } = CARDS['mic-denied'];
  await failNext(page, 'NotAllowedError');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expectCard(page, 'mic-denied');
  await failNext(page, 'NotAllowedError');
  await tryAgain(page).click();
  await expect.poll(() => assertiveLog(page)).toEqual([title, title]);
  await expect(card(page, 'mic-denied')).toBeVisible();
  expect(await gumCalls(page)).toBe(2);
  expect(errors).toEqual([]);
});

test('a mic lost while on Library is announced there', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(meter(page)).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Library');

  await page.evaluate(() => window.__fakeMic!.revoke());
  await expect.poll(() => assertiveLog(page)).toEqual([CARDS['mic-lost'].title]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Library');

  // Back on Record: the lost card, not announced again.
  await page.getByRole('navigation').getByRole('link', { name: 'Record' }).click();
  await expect(card(page, 'mic-lost')).toBeVisible();
  await page.waitForTimeout(200);
  expect(await assertiveLog(page)).toEqual([CARDS['mic-lost'].title]);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

const LOSSES: [string, (page: Page) => Promise<void>][] = [
  ['revoke', (page) => page.evaluate(() => window.__fakeMic!.revoke())],
  [
    'unplug of the only device',
    (page) => page.evaluate((id) => window.__fakeMic!.unplug(id), DEVICE),
  ],
];

for (const [what, lose] of LOSSES) {
  test(`${what} while live shows the lost card and closes the input`, async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('button', { name: 'Allow microphone' }).click();
    await expect(meter(page)).toBeVisible();
    expect(await gumCalls(page)).toBe(1);

    await lose(page);
    await expectCard(page, 'mic-lost');
    await page.waitForTimeout(300);
    expect(await gumCalls(page)).toBe(1);

    if (what === 'revoke') {
      await expectTryAgainRecovers(page, 1);
    } else {
      // The device is gone: Try again reports no device, still without a reload.
      await tryAgain(page).click();
      await expectCardTitle(page, 'mic-no-device');
      expect(await gumCalls(page)).toBe(2);
    }
    expect(errors).toEqual([]);
  });
}

async function expectCardTitle(page: Page, code: Code) {
  await expect(card(page, code)).toBeVisible();
  await expect(page.locator('[aria-live="assertive"]')).toHaveText(CARDS[code].title);
}

/** Marks the mic as granted before, then reloads into Record with the counter reset. */
async function returnVisit(page: Page) {
  await page.goto('./?fakeMic=open_strings#/record');
  await page.evaluate(() =>
    localStorage.setItem('tabcreator.prefs.v1', JSON.stringify({ version: 1, micGranted: true })),
  );
  await page.reload();
}

test('return with the permission granted goes live without a click', async ({ page, context }) => {
  const errors = collectErrors(page);
  await context.grantPermissions(['microphone']);
  await countGetUserMedia(page);
  await returnVisit(page);
  await expect(meter(page)).toBeVisible();
  await expect(page.getByRole('region', { name: SETUP_TITLE })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

const NOT_GRANTED: [string, 'denied' | 'reject' | null][] = [
  ['prompt', null],
  ['denied', 'denied'],
  ['a rejected query', 'reject'],
];

for (const [what, stub] of NOT_GRANTED) {
  test(`return with ${what} shows the setup card and asks nothing`, async ({ page }) => {
    const errors = collectErrors(page);
    if (stub) {
      // Stubs the query: Playwright can grant a permission but not deny one.
      await page.addInitScript((mode) => {
        Object.defineProperty(navigator.permissions, 'query', {
          value: () =>
            mode === 'denied'
              ? Promise.resolve({ state: 'denied' })
              : Promise.reject(new TypeError('no')),
          configurable: true,
        });
      }, stub);
    }
    await countGetUserMedia(page);
    await returnVisit(page);
    await expect(page.getByRole('region', { name: SETUP_TITLE })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await gumCalls(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}
