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

  // Spine AD-1, written out by hand so a wrong rule in eslint.config.js fails here.
  const allowed: Record<string, readonly string[]> = {
    ui: ['session', 'model'],
    session: ['model', 'storage', 'engine', 'audio'],
    storage: ['model'],
    audio: ['model'],
    engine: ['model'],
    model: [],
  };
  const allDirs = ['ui', 'session', 'model', 'storage', 'audio', 'engine'] as const;
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
