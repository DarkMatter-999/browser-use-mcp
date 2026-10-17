import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background.ts"),
        popup: resolve(import.meta.dirname, "popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: { name: "extension", include: ["test/**/*.test.ts"] },
});
