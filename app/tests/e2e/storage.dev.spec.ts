import { expect, test, type Page } from '@playwright/test';

// Runs in the `dev` project only: #/__test/storage exists only in dev builds (stories US-0.3).

/** Collects console errors and warnings plus uncaught page errors. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function runCheck(page: Page, button: string, name: string): Promise<unknown> {
  await page.getByRole('button', { name: button }).click();
  const output = page.getByTestId(`${name}-result`);
  await expect(output).not.toHaveText(/^(running)?$/, { timeout: 30_000 });
  return JSON.parse((await output.textContent()) ?? '');
}

async function openPage(page: Page): Promise<string[]> {
  // Listen before navigating so load-time errors are caught too.
  const errors = collectErrors(page);
  await page.goto('./#/__test/storage');
  await expect(page.getByRole('heading', { name: 'Storage test page' })).toBeVisible();
  return errors;
}

test('a Take and Tab round-trip in real IndexedDB; missing-take writes reject', async ({
  page,
}) => {
  const errors = await openPage(page);
  expect(await runCheck(page, 'Run records round-trip', 'records')).toEqual({
    takeEqual: true,
    tabEqual: true,
    rejections: {
      patchTake: 'take-not-found',
      putTab: 'take-not-found',
      commitAnalysis: 'take-not-found',
    },
    missingWritten: false,
    events: [
      ['take-put', 'recording-session'],
      ['tab-put', 'take-session'],
    ],
  });
  expect(errors).toEqual([]);
});

test('raw PCM appended in 1 s chunks reads back sample-exact', async ({ page }) => {
  const errors = await openPage(page);
  expect(await runCheck(page, 'Run raw round-trip', 'raw')).toEqual({
    length: 480_000,
    expectedLength: 480_000,
    sampleExact: true,
    leftover: false,
  });
  expect(errors).toEqual([]);
});

test('deleteTake leaves no take, tab, compressed audio or raw file', async ({ page }) => {
  const errors = await openPage(page);
  const result = (await runCheck(page, 'Run delete clean-up', 'delete')) as {
    before: object;
    after: object;
    events: { type: string; writer: string }[];
  };
  expect(result.before).toEqual({ take: true, tab: true, audio: true, raw: true });
  expect(result.after).toEqual({ take: false, tab: false, audio: false, raw: false });
  expect(result.events.map((e) => [e.type, e.writer])).toEqual([
    ['take-deleted', 'library-session'],
  ]);
  expect(errors).toEqual([]);
});

test("writing another format replaces the take's compressed audio", async ({ page }) => {
  const errors = await openPage(page);
  expect(await runCheck(page, 'Run format replace', 'format')).toEqual({
    type: 'audio/ogg;codecs=opus',
    bytes: [2, 2, 2, 2],
    webmGone: true,
  });
  expect(errors).toEqual([]);
});
