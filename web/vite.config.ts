import { defineConfig } from 'vite';

// Relative base so the build works from any path (GitHub Pages serves it
// from /<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
