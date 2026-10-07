import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, host: '127.0.0.1', proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false } } },
});
