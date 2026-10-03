// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

// The app package root (this file lives in app/src/).
const appDir = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: appDir });

async function restrictedImports(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((m) => m.ruleId === 'no-restricted-imports').length ?? -1;
}

async function lintRules(filePath: string, code: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.map((m) => m.ruleId) ?? [];
}

async function stylelintErrors(codeFilename: string, code: string): Promise<string[]> {
  const { results } = await stylelint.lint({ code, codeFilename, cwd: appDir });
  return results.flatMap((r) => r.warnings.map((w) => w.rule));
}

describe('ESLint layering (spine AD-1)', () => {
  it('rejects ui/ importing storage/', async () => {
    expect(await restrictedImports('src/ui/x.ts', "export { db } from '../storage/db';\n")).toBe(1);
  });

  it('allows session/ importing storage/', async () => {
    expect(
      await restrictedImports('src/session/x.ts', "export { db } from '../storage/db';\n"),
    ).toBe(0);
  });

  it('allows ui/ importing session/ and model/', async () => {
    const code = "export { s } from '../session/s';\nexport { m } from '../model/m';\n";
    expect(await restrictedImports('src/ui/screens/x.tsx', code)).toBe(0);
  });

  it('rejects model/ importing react', async () => {
    expect(await restrictedImports('src/model/x.ts', "export { useState } from 'react';\n")).toBe(
      1,
    );
  });

  it('rejects model/ importing react-dom', async () => {
    expect(
      await restrictedImports('src/model/x.ts', "export { createRoot } from 'react-dom/client';\n"),
    ).toBe(1);
  });

  it('rejects an adapter (storage/) importing react', async () => {
    expect(await restrictedImports('src/storage/x.ts', "export { useState } from 'react';\n")).toBe(
      1,
    );
  });

  it('rejects src/App.tsx importing storage/', async () => {
    expect(await restrictedImports('src/App.tsx', "export { db } from './storage/db';\n")).toBe(1);
  });

  it.each(['ui', 'session', 'model', 'storage', 'audio', 'engine'])(
    'rejects %s/ importing dev/, statically or dynamically',
    async (layer) => {
      expect(await restrictedImports(`src/${layer}/x.ts`, "export { p } from '../dev/p';\n")).toBe(
        1,
      );
      expect(
        await lintRules(`src/${layer}/x.ts`, "export const p = import('../dev/p');\n"),
      ).toContain('no-restricted-syntax');
    },
  );

  it('rejects src/App.tsx importing dev/ statically or without the DEV guard', async () => {
    expect(
      await restrictedImports('src/App.tsx', "export { P } from './dev/StorageTestPage';\n"),
    ).toBe(1);
    expect(
      await lintRules('src/App.tsx', "export const P = import('./dev/StorageTestPage');\n"),
    ).toContain('no-restricted-syntax');
    expect(
      await lintRules(
        'src/App.tsx',
        "export const P = import.meta.env.PROD ? import('./dev/StorageTestPage') : null;\n",
      ),
    ).toContain('no-restricted-syntax');
  });

  it('rejects src/App.tsx loading dev/ in the alternate branch of the DEV guard', async () => {
    expect(
      await lintRules(
        'src/App.tsx',
        "export const P = import.meta.env.DEV ? null : import('./dev/StorageTestPage');\n",
      ),
    ).toContain('no-restricted-syntax');
  });

  it('allows src/App.tsx loading dev/ behind import.meta.env.DEV', async () => {
    expect(
      await lintRules(
        'src/App.tsx',
        "export const P = import.meta.env.DEV ? import('./dev/StorageTestPage') : null;\n",
      ),
    ).toEqual([]);
    expect(
      await lintRules(
        'src/App.tsx',
        "export const P = import.meta.env.DEV ? lazy(() => import('./dev/StorageTestPage')) : null;\n",
      ),
    ).toEqual([]);
  });

  it('allows src/App.tsx loading dev/ pages from a DEV-guarded map', async () => {
    const code =
      "export const P = import.meta.env.DEV ? new Map([['#/x', lazy(() => import('./dev/X'))]]) : null;\n";
    expect(await lintRules('src/App.tsx', code)).toEqual([]);
  });

  it('rejects src/main.tsx importing dev/ statically or without the DEV guard', async () => {
    expect(
      await restrictedImports('src/main.tsx', "export { installFakeMic } from './dev/fake-mic';\n"),
    ).toBe(1);
    expect(
      await lintRules('src/main.tsx', "export const m = import('./dev/fake-mic');\n"),
    ).toContain('no-restricted-syntax');
    expect(
      await lintRules(
        'src/main.tsx',
        "if (import.meta.env.PROD) {\n  await import('./dev/fake-mic');\n}\n",
      ),
    ).toContain('no-restricted-syntax');
  });

  it('rejects src/main.tsx loading dev/ in the else branch of the DEV guard', async () => {
    expect(
      await lintRules(
        'src/main.tsx',
        "if (import.meta.env.DEV) {\n  void 0;\n} else {\n  await import('./dev/fake-mic');\n}\n",
      ),
    ).toContain('no-restricted-syntax');
  });

  it('allows src/main.tsx loading dev/ inside if (import.meta.env.DEV)', async () => {
    expect(
      await lintRules(
        'src/main.tsx',
        "if (import.meta.env.DEV) {\n  const { installFakeMic } = await import('./dev/fake-mic');\n  installFakeMic([]);\n}\n",
      ),
    ).toEqual([]);
  });

  it.each(['../App', '../App.tsx', '../main', '../main.tsx'])(
    'rejects dev/ importing the entry point %s',
    async (specifier) => {
      expect(await restrictedImports('src/dev/x.ts', `export { x } from '${specifier}';\n`)).toBe(
        1,
      );
    },
  );

  it('allows dev/ importing a non-entry module named App or main', async () => {
    const code = "export { x } from '../ui/App';\nexport { y } from './main';\n";
    expect(await restrictedImports('src/dev/x.ts', code)).toBe(0);
  });

  // Spine AD-1, written out by hand so a wrong rule in eslint.config.js fails here. dev/ is the
  // dev-only harness: it may import any layer, and no layer may import it.
  const allowed: Record<string, readonly string[]> = {
    ui: ['session', 'model'],
    session: ['model', 'storage', 'engine', 'audio'],
    storage: ['model'],
    audio: ['model'],
    engine: ['model'],
    model: [],
    dev: ['ui', 'session', 'model', 'storage', 'audio', 'engine'],
  };
  const allDirs = ['ui', 'session', 'model', 'storage', 'audio', 'engine', 'dev'] as const;
  for (const layer of allDirs) {
    for (const target of allDirs) {
      if (target === layer) continue;
      const ok = allowed[layer]?.includes(target) ?? false;
      it(`${layer}/ ${ok ? 'may' : 'may not'} import ${target}/`, async () => {
        const code = `export { x } from '../${target}/x';\n`;
        expect(await restrictedImports(`src/${layer}/x.ts`, code)).toBe(ok ? 0 : 1);
      });
    }
  }
});

describe('aria-live has one owner (spine AD-18)', () => {
  const jsx = 'export const X = () => <div aria-live="polite" />;\n';
  const createElementProp =
    "import { createElement } from 'react';\nexport const x = createElement('div', { 'aria-live': 'polite' });\n";

  it.each(['src/ui/screens/Record.tsx', 'src/ui/components/X.tsx', 'src/App.tsx', 'src/dev/X.tsx'])(
    'rejects an aria-live attribute in %s',
    async (file) => {
      expect(await lintRules(file, jsx)).toContain('no-restricted-syntax');
    },
  );

  it('rejects an aria-live createElement prop outside ui/a11y/', async () => {
    expect(await lintRules('src/ui/screens/X.ts', createElementProp)).toContain(
      'no-restricted-syntax',
    );
  });

  it('allows aria-live in ui/a11y/', async () => {
    expect(await lintRules('src/ui/a11y/announcer.ts', createElementProp)).toEqual([]);
    expect(await lintRules('src/ui/a11y/Region.tsx', jsx)).toEqual([]);
  });

  it('still rejects a dynamic dev/ import in ui/a11y/', async () => {
    expect(
      await lintRules('src/ui/a11y/x.ts', "export const p = import('../../dev/p');\n"),
    ).toContain('no-restricted-syntax');
  });
});

describe('stylelint colour literals (spine AD-12)', () => {
  it.each([
    ['hex', 'a { color: #fff; }'],
    ['named', 'a { color: red; }'],
    ['function', 'a { color: rgb(0 0 0); }'],
  ])('rejects a %s colour in a CSS module', async (_kind, code) => {
    expect((await stylelintErrors('src/ui/screens/X.module.css', code)).length).toBeGreaterThan(0);
  });

  it('accepts custom properties in a CSS module', async () => {
    expect(
      await stylelintErrors('src/ui/screens/X.module.css', 'a { color: var(--color-text); }\n'),
    ).toEqual([]);
  });

  it('exempts theme.css', async () => {
    expect(
      await stylelintErrors('src/ui/theme.css', ':root {\n  --color-text: #fff;\n}\n'),
    ).toEqual([]);
  });
});
