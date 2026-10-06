import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_DEV_PROXY_TARGET || "http://localhost:5000";

  return {
    // Absolute paths so deep links like /invite/CODE load /assets/*, not /invite/assets/*.
    base: "/",
    plugins: [react()],
    optimizeDeps: {
      include: ["mediasoup-client"],
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/health": { target, changeOrigin: true },
        "/auth": { target, changeOrigin: true },
        "/profile": { target, changeOrigin: true },
        "/push": { target, changeOrigin: true },
        "/files": { target, changeOrigin: true },
        "/avatars": { target, changeOrigin: true },
        "/uploads": { target, changeOrigin: true },
        "/servers": { target, changeOrigin: true },
        "/channels": { target, changeOrigin: true },
        "/dm": { target, changeOrigin: true },
        "/voice": { target, changeOrigin: true },
        "/hubs": { target, changeOrigin: true, ws: true },
        "/ws": { target, changeOrigin: true, ws: true },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@sloncord/server-origin": path.resolve(__dirname, "../../shared/defaultServerOrigin.mjs"),
        "@sloncord/github-config": path.resolve(__dirname, "../../shared/sloncordGithub.mjs"),
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
