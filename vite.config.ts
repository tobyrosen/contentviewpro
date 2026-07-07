import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const devHost = process.env.VITE_DEV_HOST || "localhost";
const allowedHosts = (process.env.VITE_DEV_ALLOWED_HOSTS || "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const hmrHost =
  process.env.VITE_DEV_HMR_HOST ||
  (devHost === "0.0.0.0" ? "localhost" : devHost);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: devHost,
    port: 5173,
    strictPort: true,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
    hmr: {
      host: hmrHost,
    },
    proxy: {
      "/api": "http://localhost:3033",
    },
  },
});
