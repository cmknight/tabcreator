import { test } from '@playwright/test';
import { backupRestoreRoundTrip } from './backup-restore-body';

// Runs in the `chromium` project: backup and restore on the production build at the root
// (story "Latency gates and backup on the production build"; the body is in
// backup-restore-body.ts).
test('on the production build a backup restores into a fresh profile identically, again imports nothing, under the CSP', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await backupRestoreRoundTrip(page, browser, baseURL!);
});
