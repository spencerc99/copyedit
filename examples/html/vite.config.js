import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import copyedit from 'copyedit';

export default defineConfig({
  plugins: [copyedit()],
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), about: resolve(import.meta.dirname, 'about/index.html') } } },
});
