import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, '../src') } },
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/artifact-reading.checks.tsx','test/execution-observation.checks.tsx'] },
});
