/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{vue,ts}'],
  theme: {
    extend: {
      // 主题自适应墨色/纸色：--ink / --paper 在 main.css 按 data-theme 切换，
      // 组件里的 text-black/70、bg-white/55 一律换成 text-ink/70、bg-paper/55。
      colors: {
        ink: 'rgb(var(--ink) / <alpha-value>)',
        paper: 'rgb(var(--paper) / <alpha-value>)'
      }
    }
  },
  plugins: []
}
