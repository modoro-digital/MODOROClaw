module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50:'#f0f4ff', 100:'#e0eaff', 400:'#7ba7ff', 500:'#4f8ef7', 600:'#2563eb', 700:'#1d4ed8' },
        dark: { bg:'#0a0a0f', card:'#111116', border:'#1e1e26' },
      },
    },
  },
  plugins: [],
}
