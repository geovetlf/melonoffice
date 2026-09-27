import js from '@eslint/js';
import melonoffice from '@melonoffice/config/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Server-only modules that browser code must never import. */
const SERVER_ONLY = [
  {
    group: [
      '@melonoffice/observability',
      '@melonoffice/auth',
      '@melonoffice/tenancy',
      '@melonoffice/rbac',
      '@melonoffice/audit',
      '@melonoffice/entitlements',
      '@melonoffice/billing',
    ],
    message: 'Server-only package.',
  },
  { group: ['hono', 'hono/*', '@hono/*'], message: 'Server-only dependency.' },
  { group: ['node:*'], message: 'Node built-ins are not available in the browser.' },
];

/** Applications are entry points; nothing imports them. */
const APPS = [
  {
    group: ['@melonoffice/web', '@melonoffice/api', '@melonoffice/worker'],
    message: 'Applications cannot be imported.',
  },
];

/** Workspace packages are imported by name, never by relative path into another package. */
const BY_NAME_ONLY = [
  {
    group: ['@melonoffice/*/src/*', '../../packages/*', '../../apps/*', '../../../packages/*'],
    message: 'Import workspace packages by name, not by path.',
  },
];

const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', '**/*.test-d.ts'];

/**
 * ESLint does not merge options of the same rule across config blocks, so
 * every block restates the full list of restricted patterns.
 */
function restrictImports(...groups) {
  return { 'no-restricted-imports': ['error', { patterns: [...BY_NAME_ONLY, ...groups.flat()] }] };
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { melonoffice },
    rules: {
      // D-25: never branch on plan names; ask entitlements, limits, features or permissions.
      'melonoffice/no-plan-name-comparison': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      ...restrictImports(),
    },
  },
  {
    files: ['**/*.tsx', 'apps/web/**', 'packages/ui/**', 'packages/i18n/**'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.strict.rules,
    },
  },
  {
    // Browser code: the web app cannot reach server code.
    files: ['apps/web/src/**'],
    ignores: TEST_FILES,
    rules: restrictImports(SERVER_ONLY),
  },
  {
    // UI packages: no server code and no applications.
    files: ['packages/ui/src/**', 'packages/i18n/src/**'],
    ignores: TEST_FILES,
    rules: restrictImports(SERVER_ONLY, APPS),
  },
  {
    // Server-side shared packages never depend on applications.
    files: [
      'packages/observability/src/**',
      'packages/auth/src/**',
      'packages/tenancy/src/**',
      'packages/rbac/src/**',
      'packages/audit/src/**',
      'packages/entitlements/src/**',
      'packages/billing/src/**',
      'packages/config/**',
    ],
    rules: restrictImports(APPS),
  },
  {
    // The domain is pure: no framework, no I/O, no other workspace package.
    files: ['packages/domain/src/**'],
    ignores: ['**/*.test-d.ts'],
    rules: restrictImports([
      { group: ['@melonoffice/*'], message: 'The domain package imports nothing.' },
      {
        group: ['node:*', 'react', 'react-*', 'hono', 'hono/*', '@hono/*'],
        message: 'The domain is pure: no framework or I/O.',
      },
    ]),
  },
);
