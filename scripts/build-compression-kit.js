import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const vendorDir = resolve(root, "public/vendor/compression");
mkdirSync(vendorDir, { recursive: true });

const assets = [
  [
    resolve(root, "node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
    resolve(vendorDir, "qpdf.wasm"),
  ],
  [
    resolve(root, "node_modules/@jspawn/ghostscript-wasm/gs.wasm"),
    resolve(vendorDir, "gs.wasm"),
  ],
];

for (const [source, destination] of assets) {
  if (!existsSync(source)) {
    throw new Error(`Required browser WASM asset is missing: ${source}. Run npm install before building.`);
  }
  copyFileSync(source, destination);
}

await build({
  entryPoints: {
    "compression-kit": resolve(root, "src/browser/compressionKit.ts"),
  },
  bundle: true,
  splitting: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  outdir: resolve(root, "public/js"),
  entryNames: "[name]",
  chunkNames: "compression-chunks/[name]-[hash]",
  alias: {
    fs: resolve(root, "src/browser/node-fs-shim.cjs"),
    path: resolve(root, "src/browser/node-path-shim.cjs"),
    "node:fs": resolve(root, "src/browser/node-fs-shim.cjs"),
    "node:path": resolve(root, "src/browser/node-path-shim.cjs"),
  },
  legalComments: "inline",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("Compression WASM bundle and local assets generated.");
