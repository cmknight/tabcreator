// @vitest-environment node
// Story "Bundle and wasm size gates" (spine AD-17, CAP-23): build/size-budget.ts measures the
// initial JS (entry, static imports, classic scripts) and each wasm of a dist/, and fails over
// budget. Run here on small fixture dists.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGETS_PATH } from '../../build/budgets';
import {
  check,
  main,
  measure,
  readBudgets,
  scriptSources,
  type SizeBudgets,
} from '../../build/size-budget';

let dist: string;
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'size-budget-'));
  dist = join(work, 'dist');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Pseudo-random bytes (incompressible), deterministic per seed. */
function noise(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function write(file: string, content: string | Buffer) {
  const path = join(dist, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

const gz = (file: string) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;

const HTML = `<!doctype html>
<html><head>
<script src="./theme-boot.js"></script>
<script type="module" crossorigin
  src="./assets/index-A.js"></script>
<link rel="stylesheet" href="./assets/index-A.css">
</head><body></body></html>`;

/** A dist like today's: entry → vendor → shared; lazy, worker and workbox chunks; a wasm. */
function fixture(
  opts: { manifest?: boolean; lazyBytes?: number; wasmBytes?: number; entry?: Buffer } = {},
) {
  write('index.html', HTML);
  write('theme-boot.js', '(function(){/* boot */})();');
  write('assets/index-A.js', opts.entry ?? 'import "./vendor-B.js"; console.log("entry");');
  write('assets/vendor-B.js', 'import "./shared-C.js"; export const v = 1;');
  write('assets/shared-C.js', 'export const s = 2;');
  write('assets/lazy-D.js', noise(opts.lazyBytes ?? 1000, 2));
  write('assets/engine-worker-E.js', noise(500_000, 3));
  write('assets/recorder-worklet-F.js', noise(500_000, 4));
  write('assets/index-A.css', noise(500_000, 5));
  write('assets/engine_bg-G.wasm', noise(opts.wasmBytes ?? 2000, 6));
  if (opts.manifest === false) return;
  write(
    '.vite/manifest.json',
    JSON.stringify({
      'index.html': {
        file: 'assets/index-A.js',
        src: 'index.html',
        isEntry: true,
        imports: ['_vendor-B.js'],
        dynamicImports: ['src/lazy.ts'],
        css: ['assets/index-A.css'],
      },
      '_vendor-B.js': { file: 'assets/vendor-B.js', imports: ['_shared-C.js'] },
      '_shared-C.js': { file: 'assets/shared-C.js', imports: ['_vendor-B.js'] },
      'src/lazy.ts': {
        file: 'assets/lazy-D.js',
        isDynamicEntry: true,
        imports: ['_shared-C.js'],
      },
      'src/engine/engine-worker.ts?worker': { file: 'assets/engine-worker-E.js' },
    }),
  );
}

const BIG: SizeBudgets = { initialJsGzipBytes: 1_000_000, wasmGzipBytes: 1_000_000 };

function budgetsFile(budgets: object): string {
  const path = join(work, 'budgets.json');
  writeFileSync(path, JSON.stringify(budgets));
  return path;
}

describe('measure', () => {
  it('counts the entry, its static imports and the classic script; not lazy, worker, worklet or CSS', () => {
    fixture({ lazyBytes: 900_000 });
    const m = measure(dist);
    const files = [
      'assets/index-A.js',
      'assets/vendor-B.js',
      'assets/shared-C.js',
      'theme-boot.js',
    ];
    expect(m.initialJs.map((f) => f.file)).toEqual(files);
    expect(m.initialJsGzipBytes).toBe(files.reduce((sum, f) => sum + gz(f), 0));
    // The 900 KB lazy chunk and the 500 KB worker, worklet and CSS are not in it.
    expect(m.initialJsGzipBytes).toBeLessThan(1000);
    expect(m.wasm).toEqual([
      { file: 'assets/engine_bg-G.wasm', bytes: 2000, gzipBytes: gz('assets/engine_bg-G.wasm') },
    ]);
  });

  it('gates several wasm files each on its own', () => {
    fixture();
    write('assets/other-H.wasm', noise(3000, 7));
    expect(measure(dist).wasm.map((w) => w.file)).toEqual([
      'assets/engine_bg-G.wasm',
      'assets/other-H.wasm',
    ]);
  });

  it('finds wasm in nested directories, not in .vite/', () => {
    fixture();
    write('nested/deep/other-H.wasm', noise(3000, 7));
    write('.vite/cache.wasm', noise(3000, 8));
    expect(measure(dist).wasm.map((w) => w.file)).toEqual([
      'assets/engine_bg-G.wasm',
      'nested/deep/other-H.wasm',
    ]);
  });

  it('skips scripts in comments and scripts the browser does not run', () => {
    const html = `<!-- <script src="./commented.js"></script> -->
      <script type="application/json" src="./data.json"></script>
      <script type="importmap" src="./map.json"></script>
      <script type="text/template" src="./t.html"></script>
      <script type="text/javascript" src="./classic.js"></script>
      <script type='module' src="./mod.js"></script>
      <!-- unterminated <script src="./tail.js"></script>`;
    expect(scriptSources(html)).toEqual(['./classic.js', './mod.js']);
  });

  it('fails on a root-absolute script src, naming the base', () => {
    fixture();
    write('index.html', HTML.replace('./theme-boot.js', '/theme-boot.js'));
    expect(check(dist, budgetsFile(BIG)).errors[0]).toMatch(
      /index\.html script \/theme-boot\.js: not a relative path .*base: '\.\/'/,
    );
  });

  it('turns an unreadable file into a clear error naming its path', () => {
    fixture();
    rmSync(join(dist, 'assets/vendor-B.js'));
    mkdirSync(join(dist, 'assets/vendor-B.js'));
    expect(check(dist, budgetsFile(BIG)).errors[0]).toMatch(
      /^cannot read .*assets[\\/]vendor-B\.js: EISDIR/,
    );
  });

  it('reads script srcs across lines and quote styles', () => {
    expect(scriptSources(HTML)).toEqual(['./theme-boot.js', './assets/index-A.js']);
    expect(scriptSources(`<script src='a.js'></script><script>inline()</script>`)).toEqual([
      'a.js',
    ]);
  });
});

describe('check', () => {
  it('passes within budget and reports sizes, limits and headroom', () => {
    fixture();
    const result = check(dist, budgetsFile(BIG));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.report).toContain('`theme-boot.js`');
    expect(result.report).toContain('| Initial JS (total) |');
    expect(result.report).toContain('1000000 B');
    expect(result.report).toContain('% used');
  });

  it('fails over the initial JS budget, naming the total and the limit', () => {
    fixture();
    const total = measure(dist).initialJsGzipBytes;
    const result = check(dist, budgetsFile({ ...BIG, initialJsGzipBytes: total - 1 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      `initial JS is ${total} bytes gzipped, over the ${total - 1}-byte limit (initialJsGzipBytes)`,
    ]);
    expect(result.report).toContain('**FAIL**');
  });

  it('fails over the wasm budget, naming the file, size and limit', () => {
    fixture({ wasmBytes: 50_000 });
    const size = gz('assets/engine_bg-G.wasm');
    const result = check(dist, budgetsFile({ ...BIG, wasmGzipBytes: 40_000 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      `assets/engine_bg-G.wasm is ${size} bytes gzipped, over the 40000-byte limit (wasmGzipBytes)`,
    ]);
  });

  it('does not count a big lazy chunk', () => {
    fixture({ lazyBytes: 300_000 });
    expect(check(dist, budgetsFile({ ...BIG, initialJsGzipBytes: 1000 })).ok).toBe(true);
  });

  it('fails clearly without a manifest', () => {
    fixture({ manifest: false });
    const result = check(dist, budgetsFile(BIG));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no \.vite\/manifest\.json .*build with manifest/);
  });

  it('fails clearly without an index.html entry', () => {
    fixture();
    write('.vite/manifest.json', JSON.stringify({ 'src/main.tsx': { file: 'assets/index-A.js' } }));
    const result = check(dist, budgetsFile(BIG));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no "index\.html" entry chunk/);
  });

  it('fails clearly on a missing chunk file or wasm', () => {
    fixture();
    rmSync(join(dist, 'assets/vendor-B.js'));
    expect(check(dist, budgetsFile(BIG)).errors[0]).toMatch(/assets\/vendor-B\.js: missing/);
    fixture();
    rmSync(join(dist, 'assets/engine_bg-G.wasm'));
    expect(check(dist, budgetsFile(BIG)).errors[0]).toMatch(/no \.wasm/);
  });

  it('validates the budget keys it reads', () => {
    fixture();
    for (const bad of [
      {},
      { ...BIG, wasmGzipBytes: '1 MB' },
      { ...BIG, initialJsGzipBytes: 0 },
      { ...BIG, initialJsGzipBytes: -1 },
      { ...BIG, wasmGzipBytes: 1.5 },
    ])
      expect(check(dist, budgetsFile(bad)).errors[0]).toMatch(/must be a positive integer/);
    for (const bad of [[], null])
      expect(check(dist, budgetsFile(bad as object)).errors[0]).toMatch(/not a JSON object/);
    const malformed = join(work, 'malformed.json');
    writeFileSync(malformed, '{ "initialJsGzipBytes": ');
    expect(check(dist, malformed).errors[0]).toMatch(/^cannot read budgets .*malformed\.json/);
    expect(check(dist, join(work, 'none.json')).errors[0]).toMatch(/^cannot read budgets/);
    // Other stories' keys are allowed alongside.
    expect(check(dist, budgetsFile({ ...BIG, editP95Ms: 100 })).ok).toBe(true);
  });

  it('appends the table to the summary file when given', () => {
    fixture();
    const summary = join(work, 'summary.md');
    writeFileSync(summary, '# Earlier step\n');
    check(dist, budgetsFile(BIG), summary);
    const text = readFileSync(summary, 'utf8');
    expect(text.startsWith('# Earlier step\n## Size budgets')).toBe(true);
    expect(text).toContain('| Initial JS (total) |');

    rmSync(join(dist, '.vite'), { recursive: true });
    check(dist, budgetsFile(BIG), summary);
    expect(readFileSync(summary, 'utf8')).toContain(
      '**Size budget failed:** no .vite/manifest.json',
    );
  });
});

describe('budgets.json', () => {
  it("holds AD-17's 200 KiB initial JS and 1 MiB wasm", () => {
    expect(readBudgets(BUDGETS_PATH)).toEqual({
      initialJsGzipBytes: 200 * 1024,
      wasmGzipBytes: 1024 * 1024,
    });
  });
});

describe('main', () => {
  it('exits 1 without a measurable dist and writes the summary from the environment', () => {
    const summary = join(work, 'summary.md');
    expect(main([join(work, 'nowhere')], { GITHUB_STEP_SUMMARY: summary })).toBe(1);
    expect(readFileSync(summary, 'utf8')).toContain('build with manifest');
  });
});

describe('CLI', () => {
  const cli = fileURLToPath(new URL('../../build/size-budget-cli.ts', import.meta.url));
  const run = () =>
    spawnSync(process.execPath, [cli, dist], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });

  it('exits 0 within the real budgets', () => {
    fixture();
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| Initial JS (total) |');
  });

  it('exits 1 with a size budget error over the real initial JS budget', () => {
    fixture({ entry: noise(250 * 1024, 9) });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /^size budget: initial JS is \d+ bytes gzipped, over the 204800-byte limit/m,
    );
  });
});
