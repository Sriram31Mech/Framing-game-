import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.BH_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    // BH_LAN=1 exposes the dev server on the Wi-Fi network so a phone (or the Android app) can reach it.
    host: Boolean(process.env.BH_LAN),
    port: 5173,
    strictPort: true,
    proxy: {
      // WebSocket gateway must be listed before the generic /api rule.
      '/api/v1/ws': { target: API_TARGET, ws: true, changeOrigin: true },
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api/v1/ws': { target: API_TARGET, ws: true, changeOrigin: true },
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Highest priority first: groups pull in their dependencies, so the shared React
            // runtime must be claimed before the 3D groups or it would be duplicated into them.
            {
              name: 'react',
              test: /node_modules[\\/](\.pnpm[\\/])?(react|react-dom|scheduler|@tanstack|zustand|use-sync-external-store)[@\\/]/,
              priority: 40,
            },
            // three.js core is large and changes rarely: cache it on its own, loaded only with the 3D view.
            { name: 'three', test: /node_modules[\\/](\.pnpm[\\/])?three[@\\/]/, priority: 30 },
            {
              name: 'r3f',
              test: /node_modules[\\/](\.pnpm[\\/])?(@react-three|its-fine|suspend-react|react-use-measure|react-reconciler)/,
              priority: 20,
            },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
