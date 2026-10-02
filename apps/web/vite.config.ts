import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.WEB_API_ORIGIN ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/u, ''),
      },
    },
  },
});
