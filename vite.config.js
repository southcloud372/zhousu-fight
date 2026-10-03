import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端源码在 web/，后端在 server/，通过 proxy 把 /api 转发给 Express
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
