import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', 'migrate-cli': 'src/db/migrate-cli.ts', 'seed-cli': 'src/db/seed-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle workspace packages; keep npm dependencies external.
  noExternal: [/^@sniper\//],
});
