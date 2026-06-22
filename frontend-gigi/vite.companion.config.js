import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The companion is a SEPARATE artifact from the shell app: a single self-contained IIFE
// (`dist/companion.js`) that Drupal injects on every city page (V3.md §6 Phase 4). It is
// built from one dependency-free source module (`src/companion/companion.js`), so the lib
// build just minifies + wraps it — no externals, nothing to resolve at runtime.
//
// Kept out of the app build (vite.config.js) on purpose: `emptyOutDir:false` so this build
// drops companion.js alongside the already-built shell bundle instead of wiping it. The
// npm `build` script runs the app build first, then this one.
export default defineConfig({
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/companion/companion.js'),
      name: 'GigiCompanion',
      formats: ['iife'],
      fileName: () => 'companion.js',
    },
  },
});
