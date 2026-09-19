import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.DEBUG_WEB_API_ORIGIN ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/u, ''),
      },
    },
  },
});
