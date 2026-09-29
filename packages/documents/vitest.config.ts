import { vitestPreset } from '@melonoffice/config/vitest-preset';
import { defineConfig, mergeConfig } from 'vitest/config';

// Every PDF test starts a worker thread with PDF.js (ADR-0079), about 2 s each on a busy CI runner;
// tests that read several PDFs, or a PDF and a DOCX end to end, pass Vitest's 5 s default there.
export default mergeConfig(vitestPreset, defineConfig({ test: { testTimeout: 30_000 } }));
