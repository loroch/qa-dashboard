/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#EBF0F8',
          100: '#C8D6EF',
          200: '#A5BCE6',
          300: '#82A2DD',
          400: '#5F88D4',
          500: '#3C6ECB',
          600: '#1F3A5F',
          700: '#17304F',
          800: '#0F263F',
          900: '#071C2F',
        },
      },
    },
  },
  plugins: [],
}
