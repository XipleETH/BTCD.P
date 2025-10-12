import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Use repo name as base for GitHub Pages
  base: '/BTCD.P/',
})
