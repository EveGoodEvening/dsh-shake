import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@deepseek-ai\//, 'zod'],
});
