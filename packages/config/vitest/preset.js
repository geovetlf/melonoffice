/**
 * Shared Vitest settings for workspace packages.
 *
 * Workspace packages expose their TypeScript sources under the
 * `@melonoffice/source` export condition, so tests and type checks run
 * against source without a prior build. Node at runtime uses `dist`.
 */
export const SOURCE_CONDITION = '@melonoffice/source';

/** @type {import('vitest/config').UserConfig} */
export const vitestPreset = {
  resolve: {
    conditions: [SOURCE_CONDITION, 'module', 'browser', 'development|production'],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, 'module', 'node', 'development|production'],
      externalConditions: [SOURCE_CONDITION],
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    server: {
      deps: {
        inline: [/@melonoffice\//],
      },
    },
  },
};
