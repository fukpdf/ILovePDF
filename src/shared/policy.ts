export type Mode = "recommended" | "extreme" | "lossless" | "custom";

export interface ModePolicy {
  jpegQuality: number;
  targetDpi: number;
  floorDpi: number;
  gsQFactor: number;
  minPsnrDb: number;
  minSharpnessRatio: number;
}

export const MODE_POLICY: Record<Mode, ModePolicy> = {
  recommended: { jpegQuality: 78, targetDpi: 220, floorDpi: 150, gsQFactor: 0.72, minPsnrDb: 32, minSharpnessRatio: 0.85 },
  extreme:     { jpegQuality: 58, targetDpi: 180, floorDpi: 150, gsQFactor: 0.52, minPsnrDb: 28, minSharpnessRatio: 0.80 },
  lossless:    { jpegQuality: 100, targetDpi: 300, floorDpi: 150, gsQFactor: 0.95, minPsnrDb: 40, minSharpnessRatio: 0.95 },
  custom:      { jpegQuality: 72, targetDpi: 200, floorDpi: 150, gsQFactor: 0.62, minPsnrDb: 30, minSharpnessRatio: 0.82 },
};

/** Custom mode is bounded to four attempts; every attempt starts from the original bytes. */
export const CUSTOM_QUALITY_LADDER = [88, 78, 68, 58] as const;
export const CUSTOM_GS_QFACTOR_LADDER = [0.82, 0.72, 0.62, 0.52] as const;

export const LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  browserComfortBytes: 24 * 1024 * 1024,
  wasmMaxBytes: 48 * 1024 * 1024,
  wasmMaxBytesLowMemory: 20 * 1024 * 1024,
  minImageBytesToTouch: 4096,
  minImageSavingRatio: 0.05,
  maxPages: 2000,
} as const;
