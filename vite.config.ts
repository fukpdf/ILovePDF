import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/js/",
  publicDir: false,
  define: { global: "globalThis" },
  resolve: {
    alias: [
      { find: /^node:fs$/, replacement: resolve(root, "src/browser/node-fs-shim.cjs") },
      { find: /^fs$/, replacement: resolve(root, "src/browser/node-fs-shim.cjs") },
      { find: /^node:path$/, replacement: resolve(root, "src/browser/node-path-shim.cjs") },
      { find: /^path$/, replacement: resolve(root, "src/browser/node-path-shim.cjs") },
    ],
  },
  build: {
    outDir: resolve(root, "public/js"),
    emptyOutDir: false,
    assetsInlineLimit: 0,
    target: "es2022",
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(root, "src/browser/compressionKit.ts"),
      formats: ["es"],
      fileName: () => "compression-kit.js",
    },
    rollupOptions: {
      output: {
        entryFileNames: "compression-kit.js",
        chunkFileNames: "compression-chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
