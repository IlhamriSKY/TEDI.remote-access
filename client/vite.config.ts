import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Builds the SPA into ../server/public, which the relay serves as static
// assets. `base: "./"` keeps asset URLs relative. Static files in ./public
// (e.g. icon.png favicon) are copied to the output root.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(__dirname, "../server/public"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
