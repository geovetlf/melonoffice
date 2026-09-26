import { SOURCE_CONDITION, vitestPreset } from '@melonoffice/config/vitest-preset';
import { defineConfig } from 'vitest/config';

// Resolve server dependencies as Node does. The shared preset's `module` condition picks the
// bundler-only ESM build of @opentelemetry/api (used by the Firestore client), which Node cannot
// load. mergeConfig would append to the preset's list, so the list is replaced here.
export default defineConfig({
  ...vitestPreset,
  ssr: {
    ...vitestPreset.ssr,
    resolve: {
      ...vitestPreset.ssr?.resolve,
      conditions: [SOURCE_CONDITION, 'node', 'development|production'],
    },
  },
});
