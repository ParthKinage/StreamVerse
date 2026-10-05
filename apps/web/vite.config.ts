import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Overridable so end-to-end runs can point the dev proxy at a temporary API.
const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The workspace packages ship CommonJS builds for Node. The browser bundle uses their TypeScript sources.
    alias: {
      '@tesor_gp/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@tesor_gp/blockchain/abis': path.resolve(__dirname, '../../packages/blockchain/src/abis.ts'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/playback': apiTarget,
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          ethers: ['ethers'],
          hls: ['hls.js'],
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    passWithNoTests: true,
    css: false,
  },
});
