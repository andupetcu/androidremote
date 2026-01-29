import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Override DEV flag to force production API URLs (use relative paths through proxy)
    ...(process.env.FORCE_PROD ? { 'import.meta.env.DEV': 'false' } : {}),
  },
  server: {
    port: 5173,
    host: true, // Expose to network (0.0.0.0)
    proxy: {
      '/api': {
        target: 'https://proxymdm.footprints.media',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'wss://proxymdm.footprints.media',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
})
