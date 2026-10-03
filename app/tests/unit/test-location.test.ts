// @vitest-environment node
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

describe('unit test location', () => {
  it('has no test under src/ except lint-rules.test.ts (vitest only includes tests/unit/)', () => {
    const tests = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((path) => path.split('\\').join('/'))
      .filter((path) => /\.test\.[^/]+$/.test(path));
    expect(tests).toEqual(['lint-rules.test.ts']);
  });
});
