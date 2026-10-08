import { expect, test } from '@playwright/test';
import { axeIn, seedTheme, THEMES } from './a11y-helpers';
import { recordButton, stopButton, timer } from './helpers';
import { watchHygiene } from './hygiene';
import { goLive, meter } from './mic-helpers';

// Story "Accessibility sweep: axe in both themes and keyboard-only flow" (CAP-21, US-8.2): the
// production matrix's live-mic states, in the production-mic lane (Chromium's fake capture
// device as the microphone). The group runs once per theme, the theme seeded as the stored pref
// before the first load, so every state is reached and rendered in it. The no-mic states are in
// a11y-matrix.spec.ts.

for (const theme of THEMES) {
  test(`Record: live meter, count-in, recording; Tuner: live (${theme})`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const hygiene = await watchHygiene(page, baseURL!);
    // A slow count-in (40 BPM, the slowest tempo; four beats: 6 s), so the check runs inside it.
    await seedTheme(page, theme, { countIn: { on: true, bpm: 40 } });
    const errors = await goLive(page, null);
    await expect(meter(page)).toBeVisible();
    await axeIn(page, theme, 'Record live meter');

    await recordButton(page).click();
    const cancel = page.getByRole('button', { name: 'Cancel count-in' });
    await expect(cancel).toBeVisible();
    await expect(page.getByText('Count-in · 40 BPM')).toBeVisible();
    await axeIn(page, theme, 'Record count-in');
    // Still counting in after the check: the state checked was the one meant.
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(recordButton(page)).toBeVisible();

    // Recording, without the count-in.
    const countIn = page.getByRole('button', { name: 'Count-in', exact: true });
    await countIn.click();
    await expect(countIn).toHaveAttribute('aria-pressed', 'false');
    await recordButton(page).click();
    await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
    await axeIn(page, theme, 'Record recording');
    await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
    await stopButton(page).click();
    await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Tuner' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tuner' })).toBeVisible();
    await expect(page.getByTestId('tuner-panel')).toBeVisible({ timeout: 10_000 });
    await axeIn(page, theme, 'Tuner live');

    expect(errors).toEqual([]);
    hygiene.expectClean();
  });
}
