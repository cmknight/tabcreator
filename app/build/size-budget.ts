/**
 * The bundle and wasm size gates (story "Bundle and wasm size gates", spine AD-17, CAP-23): CI
 * fails when the production build's initial JS or any `.wasm` is over its gzip budget in
 * `budgets.json`.
 *
 * - Initial JS: the `index.html` entry chunk from Vite's build manifest (`build.manifest: true`,
 *   `dist/.vite/manifest.json`) and every chunk it imports statically, transitively
 *   (`dynamicImports` are lazy and excluded), plus every other `<script src>` in `dist/index.html`
 *   (the classic `theme-boot.js`, which also runs before the first render). CSS, workers and
 *   worklets are not counted.
 * - Wasm: each `dist/assets/*.wasm`, gated on its own.
 *
 * Sizes are `zlib.gzipSync` at level 9 over the exact bytes in `dist/`. Run with Node's built-in
 * type stripping through `build/size-budget-cli.ts [distDir]` (`pnpm size:check`). It prints a Markdown
 * table, appends it to `$GITHUB_STEP_SUMMARY` when set, and exits 1 naming any size over its limit.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BUDGETS_PATH, readBudgetsJson } from './budgets.ts';

/** The budgets this script reads from `budgets.json` (other stories add their own keys). */
export interface SizeBudgets {
  initialJsGzipBytes: number;
  wasmGzipBytes: number;
}

/** One measured file: its path relative to `dist/`, raw and gzip sizes. */
export interface MeasuredFile {
  file: string;
  bytes: number;
  gzipBytes: number;
}

export interface Measurement {
  /** The initial JS files, entry first. */
  initialJs: MeasuredFile[];
  initialJsGzipBytes: number;
  wasm: MeasuredFile[];
}

/** A measurement or budget problem that fails the check with this message. */
export class SizeBudgetError extends Error {
  override name = 'SizeBudgetError';
}

/** The app directory (`app/`), which holds the default `dist/` (`budgets.json` is `./budgets.ts`'s). */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A file's bytes; any read error (missing, EISDIR, EACCES, ...) as a SizeBudgetError naming it. */
function readFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new SizeBudgetError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

/** Reads and validates the keys this script uses from a budgets file. */
export function readBudgets(path: string): SizeBudgets {
  const record = readBudgetsJson(path, (message) => new SizeBudgetError(message));
  const read = (key: keyof SizeBudgets): number => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      throw new SizeBudgetError(`budgets ${path}: "${key}" must be a positive integer of bytes`);
    return value;
  };
  return { initialJsGzipBytes: read('initialJsGzipBytes'), wasmGzipBytes: read('wasmGzipBytes') };
}

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

/** A dist-relative path from an `index.html` URL or manifest file, or an error if outside. */
function distPath(ref: string, what: string): string {
  const clean = ref.replace(/[?#].*$/, '');
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(clean) || clean.startsWith('/'))
    throw new SizeBudgetError(
      `${what} ${ref}: not a relative path inside dist/ (the check needs vite's base: './')`,
    );
  const normal = posix.normalize(clean);
  if (normal === '..' || normal.startsWith('../'))
    throw new SizeBudgetError(`${what} ${ref}: outside dist/`);
  return normal;
}

function measureFile(distDir: string, file: string): MeasuredFile {
  const path = resolve(distDir, file);
  if (!existsSync(path)) throw new SizeBudgetError(`${file}: missing from ${distDir}`);
  const bytes = readFile(path);
  return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length };
}

/** A `<script>` `type` the browser runs: none, empty, a JavaScript MIME type, or `module`. */
const JS_TYPE = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i;

/**
 * The `src` of every script the browser runs in an HTML document, in order: classic and
 * `type="module"` scripts outside comments (not JSON, import maps or templates).
 */
export function scriptSources(html: string): string[] {
  const sources: string[] = [];
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/[\r\n]+/g, ' ');
  for (const [tag] of text.matchAll(/<script\b[^>]*>/gi)) {
    const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (type && !JS_TYPE.test((type[1] ?? type[2] ?? type[3] ?? '').trim())) continue;
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = src?.[1] ?? src?.[2] ?? src?.[3];
    if (value) sources.push(value);
  }
  return sources;
}

/** The initial JS files, as defined in this file's header, entry first. */
function initialJsFiles(distDir: string): string[] {
  const manifestPath = resolve(distDir, '.vite/manifest.json');
  if (!existsSync(manifestPath))
    throw new SizeBudgetError(
      `no .vite/manifest.json in ${distDir}: build with manifest (vite build.manifest: true)`,
    );
  let manifest: Record<string, ManifestChunk>;
  try {
    manifest = JSON.parse(readFile(manifestPath).toString('utf8')) as Record<string, ManifestChunk>;
  } catch (e) {
    if (e instanceof SizeBudgetError) throw e;
    throw new SizeBudgetError(`cannot parse ${manifestPath}: ${(e as Error).message}`);
  }
  const entry = manifest['index.html'];
  if (!entry?.isEntry || typeof entry.file !== 'string')
    throw new SizeBudgetError(`${manifestPath}: no "index.html" entry chunk`);

  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  };
  // Static imports only, depth-first from the entry; dynamicImports are lazy.
  const visited = new Set<string>();
  const walk = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk || typeof chunk.file !== 'string')
      throw new SizeBudgetError(`${manifestPath}: import "${key}" has no chunk`);
    add(distPath(chunk.file, 'manifest chunk'));
    for (const imported of chunk.imports ?? []) walk(imported);
  };
  walk('index.html');

  const htmlPath = resolve(distDir, 'index.html');
  if (!existsSync(htmlPath)) throw new SizeBudgetError(`no index.html in ${distDir}`);
  for (const src of scriptSources(readFile(htmlPath).toString('utf8')))
    add(distPath(src, 'index.html script'));
  return files;
}

/** Measures a production build's initial JS and wasm. */
export function measure(distDir: string): Measurement {
  const initialJs = initialJsFiles(distDir).map((file) => measureFile(distDir, file));
  // Every .wasm anywhere in dist/ (not .vite/), each gated on its own.
  let entries: string[];
  try {
    entries = readdirSync(distDir, { recursive: true, encoding: 'utf8' });
  } catch (e) {
    throw new SizeBudgetError(`cannot list ${distDir}: ${(e as Error).message}`);
  }
  const wasmFiles = entries
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.wasm') && !name.startsWith('.vite/'))
    .sort();
  if (wasmFiles.length === 0) throw new SizeBudgetError(`no .wasm in ${distDir}`);
  return {
    initialJs,
    initialJsGzipBytes: initialJs.reduce((sum, f) => sum + f.gzipBytes, 0),
    wasm: wasmFiles.map((name) => measureFile(distDir, name)),
  };
}

/** One message per size over its limit; empty when every size is within budget. */
export function overBudget(m: Measurement, budgets: SizeBudgets): string[] {
  const errors: string[] = [];
  if (m.initialJsGzipBytes > budgets.initialJsGzipBytes)
    errors.push(
      `initial JS is ${m.initialJsGzipBytes} bytes gzipped, over the ${budgets.initialJsGzipBytes}-byte limit (initialJsGzipBytes)`,
    );
  for (const w of m.wasm)
    if (w.gzipBytes > budgets.wasmGzipBytes)
      errors.push(
        `${w.file} is ${w.gzipBytes} bytes gzipped, over the ${budgets.wasmGzipBytes}-byte limit (wasmGzipBytes)`,
      );
  return errors;
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
/** Bytes and KiB; negative when over a limit. */
const size = (bytes: number) => `${bytes} B (${kib(bytes)})`;
const headroom = (used: number, limit: number) =>
  `${size(limit - used)} (${((used / limit) * 100).toFixed(1)}% used)`;

/** The Markdown report: every measured file, the totals, limits and headroom. */
export function report(m: Measurement, budgets: SizeBudgets): string {
  const lines = [
    '## Size budgets',
    '',
    '| Group | File | Raw | Gzip |',
    '| --- | --- | ---: | ---: |',
    ...m.initialJs.map(
      (f) => `| Initial JS | \`${f.file}\` | ${size(f.bytes)} | ${size(f.gzipBytes)} |`,
    ),
    ...m.wasm.map((f) => `| Wasm | \`${f.file}\` | ${size(f.bytes)} | ${size(f.gzipBytes)} |`),
    '',
    '| Budget | Gzip | Limit | Headroom | Status |',
    '| --- | ---: | ---: | ---: | --- |',
    `| Initial JS (total) | ${size(m.initialJsGzipBytes)} | ${size(budgets.initialJsGzipBytes)} | ${headroom(m.initialJsGzipBytes, budgets.initialJsGzipBytes)} | ${m.initialJsGzipBytes <= budgets.initialJsGzipBytes ? 'pass' : '**FAIL**'} |`,
    ...m.wasm.map(
      (f) =>
        `| Wasm \`${f.file}\` | ${size(f.gzipBytes)} | ${size(budgets.wasmGzipBytes)} | ${headroom(f.gzipBytes, budgets.wasmGzipBytes)} | ${f.gzipBytes <= budgets.wasmGzipBytes ? 'pass' : '**FAIL**'} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

export interface CheckResult {
  ok: boolean;
  /** The Markdown report, or empty when the build could not be measured. */
  report: string;
  errors: string[];
}

/**
 * Measures `distDir` against `budgetsPath`, and appends the report to `summaryPath` when given
 * (CI's `$GITHUB_STEP_SUMMARY`). Never throws for a measurement or budget problem: it is an error.
 */
export function check(distDir: string, budgetsPath: string, summaryPath?: string): CheckResult {
  let result: CheckResult;
  try {
    const budgets = readBudgets(budgetsPath);
    const m = measure(distDir);
    const errors = overBudget(m, budgets);
    result = { ok: errors.length === 0, report: report(m, budgets), errors };
  } catch (e) {
    if (!(e instanceof SizeBudgetError)) throw e;
    result = { ok: false, report: '', errors: [e.message] };
  }
  if (summaryPath) {
    const failures = result.errors.map((e) => `- **Size budget failed:** ${e}`).join('\n');
    appendFileSync(summaryPath, `${result.report || '## Size budgets\n\n'}${failures}\n`);
  }
  return result;
}

/**
 * The CLI (`build/size-budget-cli.ts [distDir]`): exit 0 within budget, 1 otherwise. The default
 * dist is `app/dist`, like `app/budgets.json` resolved from this file, not the working directory.
 */
export function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const distDir = argv[0] ? resolve(argv[0]) : resolve(APP_DIR, 'dist');
  const result = check(distDir, BUDGETS_PATH, env.GITHUB_STEP_SUMMARY || undefined);
  if (result.report) console.log(result.report);
  for (const error of result.errors) console.error(`size budget: ${error}`);
  return result.ok ? 0 : 1;
}
