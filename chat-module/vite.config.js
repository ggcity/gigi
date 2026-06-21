import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two roles:
//  - `vite` / `vite preview` serve the demo harness (demo/index.html) with DEV=true,
//    so the dev-only debug logger (src/debug.js) is active.
//  - `vite build` emits the publishable library bundle with PROD=true, so every
//    `import.meta.env.DEV` branch is statically false and dead-code-eliminated.
export default defineConfig({
  // Serve the demo harness as the dev root.
  root: resolve(__dirname, 'demo'),
  resolve: {
    // Let demo/test code import the package by its src entry.
    alias: {
      '@ggcity/gigi-chat': resolve(__dirname, 'src/index.js'),
    },
  },
  server: {
    // The demo imports ../src and ../test/fixtures (above the demo root).
    fs: { allow: [resolve(__dirname)] },
  },
  build: {
    // Build the library, not the demo, on `vite build`.
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      formats: ['es'],
      fileName: () => 'gigi-chat.js',
    },
    rollupOptions: {
      // Lit ships its own ESM; keep it external so consumers dedupe a single copy.
      external: ['lit', 'lit/directives/unsafe-html.js', 'lit/directives/repeat.js'],
    },
    // No minify-mangling of our public method names is needed (they're on a class),
    // but esbuild minify still drops the dead DEV branches. Keep readable-ish output.
    minify: 'esbuild',
    sourcemap: true,
  },
});
