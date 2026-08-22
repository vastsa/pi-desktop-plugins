import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 面板经 file:// 加载：ES module 脚本会被 CORS 阻止，依赖（Vue/CodeMirror/
// markdown-it）必须打进单个普通脚本。CodeMirror 6 含动态 import，
// 因此 iife 格式必须 inlineDynamicImports，产物为 renderer/assets/app.js。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: '../renderer/assets',
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: 'esbuild',
    rollupOptions: {
      input: 'src/main.ts',
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app[extname]'
      }
    }
  }
})
