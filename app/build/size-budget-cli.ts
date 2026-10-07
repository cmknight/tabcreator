/**
 * The size budget CLI (`pnpm size:check`, CI's "Size budgets" step): always runs
 * build/size-budget.ts's `main`, so the gate can never be skipped by an entry-point check.
 * `node build/size-budget-cli.ts [distDir]`; exits 1 over budget or when dist/ cannot be measured.
 */
import { main } from './size-budget.ts';

process.exitCode = main(process.argv.slice(2), process.env);
