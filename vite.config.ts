import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 需要一个固定端口，且不能在构建时清屏，否则 Rust 侧的日志会被吞掉。
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Tauri 用 tauri:// 自定义协议加载页面，绝对路径 /assets 会 404，必须用相对路径
  base: './',
  clearScreen: false,
  server: {
    // 固定 IPv4：Vite 默认只监听 ::1，Tauri 的 localhost 解析可能落到 127.0.0.1 而连不上
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
  },
});
