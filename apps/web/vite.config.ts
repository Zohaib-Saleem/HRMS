import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Proxying keeps the browser on a single origin in development, so the
    // session cookie is same-site and CORS never enters the picture.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Vendor code split by how often it changes.
         *
         * Routes are already lazy, so what is left in the entry chunk is the
         * framework. Separating it means a deploy that only touches our code
         * does not invalidate the cached React and Radix bundles. Grouped
         * rather than one-chunk-per-package: hundreds of tiny requests would
         * cost more than they save.
         */
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          // Only leaf packages here. react-router pulls in small helpers that
          // land in `vendor`, and grouping it with React makes the two chunks
          // import each other - a cycle Rollup warns about and which can bite
          // at runtime through module initialisation order.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (id.includes('@radix-ui')) return 'vendor-radix';
          if (/@tanstack|react-hook-form|@hookform|zod/.test(id)) return 'vendor-forms';
          return 'vendor';
        },
      },
    },
  },
});
