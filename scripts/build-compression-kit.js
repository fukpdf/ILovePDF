import { copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

const root = process.cwd();
const vendorDir = resolve(root, "public/vendor/compression");
const outDir = resolve(root, "public/js");
mkdirSync(vendorDir, { recursive: true });

const vendorAssets = [
  [resolve(root, "node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"), resolve(vendorDir, "qpdf.wasm")],
  [resolve(root, "node_modules/@jspawn/ghostscript-wasm/gs.wasm"), resolve(vendorDir, "gs.wasm")],
];
for (const [source, destination] of vendorAssets) {
  if (!existsSync(source)) throw new Error(`Required local WASM asset is missing: ${source}`);
  copyFileSync(source, destination);
}

await build({ configFile: resolve(root, "vite.config.ts") });

const entryBundle = resolve(outDir, "compression-kit.js");
if (!existsSync(entryBundle)) throw new Error("Vite did not emit public/js/compression-kit.js.");
const entrySource = readFileSync(entryBundle, "utf8");
if (/(?:from\s*|import\s*\()\s*["'](?:node:)?(?:fs|path|os|crypto|worker_threads|child_process)(?:\/[^"']*)?["']/.test(entrySource)) {
  throw new Error("Browser bundle contains an unresolved Node builtin import.");
}
const chunkDir = resolve(outDir, "compression-chunks");
const chunks = existsSync(chunkDir) ? readdirSync(chunkDir).filter(name => name.endsWith(".js")) : [];
if (chunks.length === 0) throw new Error("Vite did not emit lazy-loaded engine chunks.");
const assetsDir = resolve(outDir, "assets");
const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
if (!assets.some(name => name.endsWith(".wasm"))) throw new Error("Vite did not emit local WASM URL assets.");
if (!assets.some(name => /pdf\.worker.*\.mjs$/.test(name))) throw new Error("Vite did not emit the PDF.js worker URL asset.");
for (const name of ["qpdf.wasm", "gs.wasm"]) {
  if (!existsSync(resolve(vendorDir, name))) throw new Error(`Missing same-origin WASM fallback asset: ${name}`);
}
console.log(`Vite compression bundle emitted with ${chunks.length} lazy chunks, ${assets.length} URL assets and local WASM fallbacks.`);
