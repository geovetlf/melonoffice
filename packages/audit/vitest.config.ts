import { vitestPreset } from '@melonoffice/config/vitest-preset';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(vitestPreset, defineConfig({}));
