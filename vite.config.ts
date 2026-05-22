import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite root is `src/` — HTML files live there and the lib modules are
// next to them. The built output goes to `dist/` at the project root,
// which `tauri.conf.json` points at as the production frontend.

export default defineConfig({
  root: "src",
  publicDir: "public",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/index.html"),
        settings: resolve(__dirname, "src/settings.html"),
      },
    },
  },
});
