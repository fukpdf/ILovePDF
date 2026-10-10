import { copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const vendorDir = resolve(root, "public/vendor/compression");
const chunkDir = resolve(root, "public/js/compression-chunks");
mkdirSync(vendorDir, { recursive: true });
rmSync(chunkDir, { recursive: true, force: true });
mkdirSync(chunkDir, { recursive: true });

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

const buildResult = await build({
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
  metafile: true,
  logLevel: "info",
});

const entryBundle = resolve(root, "public/js/compression-kit.js");
if (!existsSync(entryBundle)) {
  throw new Error("Compression entry bundle was not emitted at public/js/compression-kit.js.");
}
const generatedChunks = readdirSync(chunkDir).filter((name) => name.endsWith(".js"));
if (generatedChunks.length === 0) {
  throw new Error("WASM engine imports were not split into lazy-loaded browser chunks.");
}
const emittedJs = [entryBundle, ...generatedChunks.map((name) => resolve(chunkDir, name))];
const bareNodeImport = /(?:from\s*|import\s*\()\s*["'](?:node:)?(?:fs|path)["']/;
for (const file of emittedJs) {
  const source = readFileSync(file, "utf8");
  if (bareNodeImport.test(source)) {
    throw new Error(\`Browser bundle contains an unresolved Node builtin import: \${file}\`);
  }
}
for (const name of ["qpdf.wasm", "gs.wasm"]) {
  if (!existsSync(resolve(vendorDir, name))) {
    throw new Error(\`Required local WASM asset was not staged: \${name}\`);
  }
}
if (!buildResult.metafile?.outputs || Object.keys(buildResult.metafile.outputs).length < 2) {
  throw new Error("Build metadata did not report the lazy engine chunks.");
}

console.log(\`Compression browser bundle generated with \${generatedChunks.length} lazy chunks and local WASM assets.\`);
