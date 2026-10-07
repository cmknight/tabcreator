import { test } from '@playwright/test';
import { backupRestoreRoundTrip } from './backup-restore-body';

// Runs in the `subpath` project: backup and restore on the production build served under
// /tabcreator/, as GitHub Pages serves a project site (story "Latency gates and backup on the
// production build"; the body is in backup-restore-body.ts).
test('under a sub-path a backup restores into a fresh profile identically, again imports nothing, under the CSP', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await backupRestoreRoundTrip(page, browser, baseURL!);
});
