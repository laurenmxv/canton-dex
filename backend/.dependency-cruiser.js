/**
 * Module boundaries of the TypeScript source tree. The composition root, `src/main.ts`, wires
 * the stores, so it is not a dependent module.
 */
const SQL_MODULES = '^src/(iam|onboarding|pools|swaps|liquidity|settlements|operations|tokens|bootstrap)/';
const COMPOSITION_ROOT = '^src/main\\.ts$';
/** The DVO decision command composes its own stores and ledger identity. */
const CLI = '^src/cli/';

export default {
  forbidden: [
    {
      name: 'no-module-cycles',
      comment: 'Top-level modules stay free of cycles.',
      severity: 'error',
      scope: 'folder',
      from: { path: '^src/' },
      to: { circular: true },
    },
    {
      name: 'sql-in-store-modules',
      comment: 'Only business modules with stores, and the pool owner, use the SQL client.',
      severity: 'error',
      from: { path: '^src/', pathNot: [SQL_MODULES, '^src/platform/database\\.ts$'] },
      to: { path: 'node_modules/(pg|kysely)/' },
    },
    {
      name: 'ledger-types-in-canton',
      comment: 'Only the Canton adapter uses the generated Ledger API wire types.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/canton/' },
      to: { path: '^src/canton/generated/' },
    },
    {
      name: 'onboarding-store-in-onboarding',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/onboarding/', COMPOSITION_ROOT] },
      to: { path: '^src/onboarding/store\\.ts$' },
    },
    {
      name: 'token-registry-store-owners',
      comment: 'Other modules read registered instruments through the instrument catalog.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/(tokens|canton|bootstrap)/', COMPOSITION_ROOT, CLI] },
      to: { path: '^src/tokens/registry-store\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
