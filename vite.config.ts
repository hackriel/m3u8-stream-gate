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
    exclude: ['express', 'ws', 'multer', 'cors', 'concurrently'],
    esbuildOptions: {
      target: 'es2020',
    },
  },
  ssr: {
    noExternal: [],
    external: ['express', 'ws', 'multer', 'cors', 'concurrently'],
  },
  build: {
    target: 'es2020',
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      external: (id) => {
        // Excluir módulos de Node.js y librerías de servidor
        const nodeModules = ['child_process', 'fs', 'path', 'url', 'http', 'https', 'stream', 'util', 'os', 'crypto', 'net', 'tls', 'zlib', 'events', 'buffer', 'querystring', 'async_hooks'];
        const serverLibs = ['express', 'ws', 'multer', 'cors', 'concurrently'];
        return nodeModules.some(mod => id === mod || id.startsWith(`node:${mod}`)) ||
               serverLibs.some(lib => id === lib || id.startsWith(lib + '/'));
      },
    },
  },
}));
