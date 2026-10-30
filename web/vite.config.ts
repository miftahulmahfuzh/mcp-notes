import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const target = `http://127.0.0.1:${process.env.NOTESD_PORT || 7317}`;

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
    rolldownOptions: {
      input: {
        index: resolve(root, 'index.html'),
        fullscreen: resolve(root, 'fullscreen.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target },
      '/mcp': { target },
      '/health': { target },
    },
  },
});
