import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The shell is an APP (not a library): `vite build` emits dist/index.html + assets,
// which the FastAPI backend serves at "/" (see backend/app.py). The package root is
// the dev/serve root, so /src/*.js are served as real ES modules in dev — the unit
// specs import them directly (e.g. `import('/src/urls.js')`).
//
//  - Dev (`vite`) proxies `/ws` to the Phase 1 backend so the browser sees ONE origin
//    (no CORS), mirroring the production reverse proxy.
//  - `@ggcity/gigi-chat` resolves to the chat module's SOURCE so the shell needs no
//    prebuild of that package; Vite dedupes the single `lit` copy.
export default defineConfig({
  root: resolve(__dirname),
  resolve: {
    alias: {
      '@ggcity/gigi-chat': resolve(__dirname, '../chat-module/src/index.js'),
    },
    // One Lit instance across the shell and the chat-module source, or custom
    // elements double-register.
    dedupe: ['lit', '@lit/reactive-element', 'lit-element', 'lit-html'],
  },
  server: {
    // The chat-module source lives above this root; allow Vite to read it.
    fs: { allow: [resolve(__dirname), resolve(__dirname, '..')] },
    proxy: {
      // Backend WebSocket. `ws:true` upgrades the connection; the shell connects to
      // a RELATIVE `/ws`, so the same code path works dev-proxied and backend-served.
      '/ws': { target: 'ws://localhost:8000', ws: true, changeOrigin: true },
      // Backend health/diagnostics, handy when probing the proxied backend.
      '/healthz': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
});
