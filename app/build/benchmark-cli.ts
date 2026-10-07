/**
 * The analysis benchmark CLI (`pnpm --filter app benchmark`, CI's "Benchmark" step): always runs
 * build/benchmark.ts's `main`, so the gate can never be skipped by an entry-point check.
 * `node build/benchmark-cli.ts [--limit-ms N] [distDir]`; exits 1 when the calibrated 60 s median
 * is over `analysis60sMs`, the config is invalid, or the gated runs cannot be measured.
 *
 * The benchmark imports app modules (the default analysis settings from `src/storage/prefs.ts`),
 * whose relative imports have no extension, as Vite resolves them. Node's type stripping does not,
 * so a resolve hook retries a relative specifier that is not found with `.ts`, then `.tsx`; it is
 * registered before the benchmark is imported.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      const relative = /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier);
      if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND' || !relative) throw e;
      for (const ext of ['.ts', '.tsx']) {
        try {
          return nextResolve(specifier + ext, context);
        } catch {
          // try the next extension
        }
      }
      throw e;
    }
  },
});

const { main } = await import('./benchmark.ts');
process.exitCode = await main(process.argv.slice(2), process.env);
