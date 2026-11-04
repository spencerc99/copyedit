import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import directedit from 'directedit';

export default defineConfig({
  plugins: [directedit()],
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), about: resolve(import.meta.dirname, 'about/index.html') } } },
});
