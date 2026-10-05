import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: { '/api': 'http://127.0.0.1:4317' } }, build: { chunkSizeWarningLimit: 1500 }, esbuild: { jsx: 'automatic' } });
