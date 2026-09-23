import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 显式绑定 IPv4 回环地址：vite 默认的 localhost 在部分 Windows 环境只解析到 ::1，
    // 会导致浏览器访问 http://127.0.0.1:3000 打不开（只有 localhost 能开）。
    host: '127.0.0.1',
    port: 3000,
    // 必须固定 3000：若被占用则直接报错退出，绝不自动漂移到 3001
    // （漂移会与后端智能体服务撞端口，表现为「前端能开、但所有接口 404」）
    strictPort: true,
    open: true,
    proxy: {
      // 智能体服务端（Express）—— 前端不接触 API Key
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE 必须关闭缓冲
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
})
