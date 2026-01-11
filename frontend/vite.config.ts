import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      // Frontend chama /api/* e o Vite encaminha para o backend FastAPI
      '/api': 'http://localhost:8000',
    },
  },
})
