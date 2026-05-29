import { defineConfig } from 'vite';

// Large PNGs (the 6MB background) should be emitted as files, not inlined as
// base64 data URLs. assetsInlineLimit: 0 keeps every asset as a real URL.
export default defineConfig({
  base: './',
  server: {
    host: true,
    // Port comes from the launcher via the PORT env var; no hardcoded fallback
    // so Vite is free to pick an open port when PORT is unset.
    port: Number(process.env.PORT) || undefined,
    strictPort: false,
  },
  build: {
    assetsInlineLimit: 0,
  },
});
