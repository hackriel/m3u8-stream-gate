import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  optimizeDeps: {
    include: ['@supabase/supabase-js'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      external: (id) => {
        // Excluir módulos de Node.js del build del frontend
        const nodeModules = ['child_process', 'fs', 'path', 'url', 'http', 'https', 'stream', 'util', 'os', 'crypto', 'net', 'tls', 'zlib', 'events', 'buffer', 'querystring'];
        return nodeModules.some(mod => id === mod || id.startsWith(`node:${mod}`));
      },
    },
  },
}));
