import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/health": { target: "http://localhost:5000", changeOrigin: true },
      "/auth": { target: "http://localhost:5000", changeOrigin: true },
      "/platform": { target: "http://localhost:5000", changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist-ui",
    emptyOutDir: true,
  },
});
