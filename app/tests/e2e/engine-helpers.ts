/**
 * The engine worker of a running app, shared by engine.spec.ts and the analysis benchmark
 * (`build/benchmark.ts`). Pure Playwright API (no `expect`), so the benchmark loads it with Node's
 * type stripping.
 */
import type { Page, Worker } from '@playwright/test';

/**
 * Opens Settings and returns the engine worker it spawned, once the engine is ready (its version
 * shows). A failure is thrown as `fail(message)`: by default a plain `Error`.
 */
export async function engineWorker(
  page: Page,
  fail: (message: string) => Error = (message) => new Error(message),
): Promise<Worker> {
  await page.goto('./#/settings');
  try {
    await page
      .getByTestId('engine-version')
      .filter({ hasText: /^Engine v\d+\.\d+\.\d+$/ })
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch (e) {
    throw fail(`the engine did not become ready: ${(e as Error).message}`);
  }
  const worker = page.workers().find((w) => w.url().includes('engine-worker'));
  if (!worker) throw fail('no engine worker found');
  return worker;
}
