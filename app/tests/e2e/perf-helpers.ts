/**
 * Shared by the latency perf specs (story "Latency gates and backup on the production build",
 * spine AD-17): the gate's limit from `app/budgets.json` (with an environment override that may
 * only lower it, to show the gate failing), the nearest-rank percentile, and the CI job summary.
 *
 * The gates measure the production build served at the root (the `perf` project,
 * playwright.config.ts), with the service worker blocked, so its precache install does not
 * compete for the CPU while the timings run.
 *
 * Pure Node (no Playwright import), so the unit tests cover it.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `app/budgets.json`. */
export const BUDGETS_PATH = resolve(import.meta.dirname, '..', '..', 'budgets.json');

/** A budgets or override problem: the spec fails with this message. */
export class PerfConfigError extends Error {
  override name = 'PerfConfigError';
}

/** The latency limits in `budgets.json`, each with the environment variable that may lower it. */
export const LIMITS = {
  editP95Ms: 'TABCREATOR_EDIT_P95_MS',
  searchP95Ms: 'TABCREATOR_SEARCH_P95_MS',
} as const;
export type LimitKey = keyof typeof LIMITS;

export interface Limit {
  key: LimitKey;
  /** The limit gated (ms): the budget, or the override when one is set. */
  ms: number;
  /** The budget in `budgets.json` (ms). */
  budgetMs: number;
  /** The environment variable that set `ms`, when one did. */
  override?: string;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Reads `key` from `budgetsPath` (a positive number of milliseconds) and applies its override
 * from `env`, which must be a positive number no higher than the budget. Throws a
 * `PerfConfigError` naming the file, key or variable otherwise.
 */
export function readLimit(
  key: LimitKey,
  env: NodeJS.ProcessEnv = process.env,
  budgetsPath: string = BUDGETS_PATH,
): Limit {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  } catch (e) {
    throw new PerfConfigError(`cannot read budgets ${budgetsPath}: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new PerfConfigError(`budgets ${budgetsPath}: not a JSON object`);
  const budgetMs = (json as Record<string, unknown>)[key];
  if (!positive(budgetMs))
    throw new PerfConfigError(
      `budgets ${budgetsPath}: "${key}" must be a positive number of milliseconds`,
    );
  const name = LIMITS[key];
  const raw = env[name];
  if (raw === undefined || raw === '') return { key, ms: budgetMs, budgetMs };
  const ms = Number(raw);
  if (!/^\s*\d+(\.\d+)?\s*$/.test(raw) || !positive(ms))
    throw new PerfConfigError(`${name}="${raw}": must be a positive number of milliseconds`);
  if (ms > budgetMs)
    throw new PerfConfigError(
      `${name}=${ms} may only lower the limit, not raise it over ${key} (${budgetMs} ms)`,
    );
  return { key, ms, budgetMs, override: name };
}

/** How a limit reads in a report: `100 ms (editP95Ms)` or `1 ms (TABCREATOR_EDIT_P95_MS)`. */
export const limitLabel = (limit: Limit): string =>
  `${limit.ms} ms (${limit.override ?? limit.key})`;

/**
 * The gate's verdict: whether `p95Ms` is within `limit` (≤ `limit.ms`). A value that is not a
 * finite number (no samples) is never within it.
 */
export function withinLimit(p95Ms: number, limit: Limit): boolean {
  return Number.isFinite(p95Ms) && p95Ms <= limit.ms;
}

/** The nearest-rank percentile `p` (0–100) of `values`. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new PerfConfigError('no samples to take a percentile of');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Rounds to 0.1 ms. */
export const round = (ms: number): number => Math.round(ms * 10) / 10;

/** A Markdown table: `head`, then `rows`, with `|` in a cell escaped. */
export function markdownTable(head: readonly string[], rows: readonly (readonly string[])[]) {
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

/**
 * Appends `markdown` to `$GITHUB_STEP_SUMMARY` when it is set (CI); nothing otherwise. A failed
 * write only warns, so it never stands in for the gate's own verdict.
 */
export function appendSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${markdown.trimEnd()}\n\n`);
  } catch (e) {
    console.warn(`cannot append to the job summary ${path}: ${(e as Error).message}`);
  }
}
