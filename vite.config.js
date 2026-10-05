import { defineConfig } from 'vite';

const apiPort = Number(process.env.DEV_API_PORT || 4318);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || apiPort === 5173) {
  throw new Error('DEV_API_PORT must be an integer from 1 to 65535, different from the UI port 5173.');
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  build: { chunkSizeWarningLimit: 1500 },
  esbuild: { jsx: 'automatic' },
});
