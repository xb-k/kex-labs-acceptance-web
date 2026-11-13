import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { acceptanceApi } from './server/api'

export default defineConfig({
  plugins: [react(), acceptanceApi()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: 'dist'
  }
})
