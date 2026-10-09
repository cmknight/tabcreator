/**
 * Reading the gates' JSON config files (spine AD-17): `readBudgetsJson` reads `app/budgets.json`
 * for the size gate (`build/size-budget.ts`), the analysis benchmark (`build/benchmark.ts`) and
 * the latency perf specs (`tests/e2e/perf-helpers.ts`); `readJsonObject` under it also reads the
 * benchmark's `benchmark.config.json`. Each caller validates its own keys and throws its own error
 * type, built by the `fail` it passes.
 *
 * Pure Node with no app imports, so it loads under Node's type stripping, Playwright and Vitest.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `app/budgets.json`. */
export const BUDGETS_PATH = resolve(import.meta.dirname, '..', 'budgets.json');

/**
 * Reads `path` as a JSON object. A read or parse failure is `cannot read {what} {path}: {reason}`
 * and anything but an object is `{what} {path}: not a JSON object`, each thrown as `fail(message)`.
 */
export function readJsonObject(
  path: string,
  what: string,
  fail: (message: string) => Error,
): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw fail(`cannot read ${what} ${path}: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw fail(`${what} ${path}: not a JSON object`);
  return json as Record<string, unknown>;
}

/** Reads a budgets file as a JSON object, throwing `fail(message)` when it cannot. */
export function readBudgetsJson(
  path: string,
  fail: (message: string) => Error,
): Record<string, unknown> {
  return readJsonObject(path, 'budgets', fail);
}
