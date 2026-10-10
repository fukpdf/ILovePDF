import { MODE_POLICY, type Mode } from "./policy";

/**
 * Ghostscript is allowed to be a candidate generator only. The caller must
 * validate the PDF object graph and decoded page-content hashes before use.
 * These flags avoid colour conversion, mono downsampling/JBIG2, and chroma
 * subsampling; any runtime rejection must fall back to the safer QPDF result.
 */
export function buildGsArgs(mode: Mode, qFactor: number, inputPath: string, outputPath: string): string[] {
  const policy = MODE_POLICY[mode];
  const dpi = Math.max(policy.floorDpi, Math.round(policy.targetDpi));
  const q = Math.max(0.1, Math.min(1, qFactor));
  const distiller = [
    "<<",
    "/ColorConversionStrategy /LeaveColorUnchanged",
    "/ColorImageDict << /QFactor " + q + " /HSamples [1 1 1 1] /VSamples [1 1 1 1] >>",
    "/GrayImageDict << /QFactor " + q + " /HSamples [1 1 1 1] /VSamples [1 1 1 1] >>",
    "/MonoImageFilter /CCITTFaxEncode",
    "/MonoImageDict << /K -1 >>",
    ">> setdistillerparams",
  ].join(" ");
  return [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.7",
    "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET",
    "-dDetectDuplicateImages=true",
    "-dCompressFonts=false",
    "-dEmbedAllFonts=true",
    "-dPreserveAnnots=true",
    "-dDownsampleMonoImages=false",
    "-dDownsampleGrayImages=true",
    "-dDownsampleColorImages=true",
    `-dColorImageResolution=${dpi}`,
    `-dGrayImageResolution=${dpi}`,
    "-dMonoImageResolution=600",
    "-dColorImageDownsampleType=/Bicubic",
    "-dGrayImageDownsampleType=/Bicubic",
    "-dColorImageFilter=/DCTEncode",
    "-dGrayImageFilter=/DCTEncode",
    "-dMonoImageFilter=/CCITTFaxEncode",
    "-dQFactor=" + q,
    "-c", distiller,
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];
}

/** QPDF structural compaction preserves stream payloads; callers must validate the candidate. */
export function buildQpdfArgs(inputPath: string, outputPath: string): string[] {
  return ["--stream-data=preserve", "--object-streams=generate", "--compression-level=9", "--linearize", inputPath, outputPath];
}
