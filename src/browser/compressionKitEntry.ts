import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import ghostscriptWasmUrl from "@jspawn/ghostscript-wasm/gs.wasm?url";
import { configureWasmAssets } from "./wasmCli";

configureWasmAssets({ qpdfWasmUrl, ghostscriptWasmUrl });
export { compressLosslessly } from "./compressionKit";
