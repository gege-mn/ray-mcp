import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  // Node 18 is the floor declared in package.json "engines".
  target: 'node18',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  // The MCP SDK stays a runtime dependency (installed by npx), everything
  // else is bundled into a single file.
  banner: { js: '#!/usr/bin/env node' },
});
