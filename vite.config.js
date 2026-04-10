import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve("client"),
  envDir: path.resolve("."),
  envPrefix: ["VITE_", "GOOGLE_MAPS_"],
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: path.resolve("dist"),
    emptyOutDir: true,
  },
});
