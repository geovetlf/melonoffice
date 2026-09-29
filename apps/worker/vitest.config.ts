import { SOURCE_CONDITION, vitestPreset } from '@melonoffice/config/vitest-preset';
import { defineConfig } from 'vitest/config';

// Resolve server dependencies as Node does. The shared preset's `module` condition picks the
// bundler-only ESM build of @opentelemetry/api (used by the Firestore client), which Node cannot
// load. mergeConfig would append to the preset's list, so the list is replaced here.
export default defineConfig({
  ...vitestPreset,
  // Worker tests also run against one shared Firestore emulator, file by file in parallel; the first
  // test of a file can wait on it well past Vitest's 5 s default on a busy CI runner (a first plan
  // run on the emulator has taken over 20 s there).
  test: { ...vitestPreset.test, testTimeout: 40_000 },
  ssr: {
    ...vitestPreset.ssr,
    resolve: {
      ...vitestPreset.ssr?.resolve,
      conditions: [SOURCE_CONDITION, 'node', 'development|production'],
    },
  },
});
