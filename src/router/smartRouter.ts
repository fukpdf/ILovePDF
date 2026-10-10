export type UiCompressionMode = "deep" | "custom";
export interface RouteDecisionInput {
  mode: UiCompressionMode;
  originalBytes: number;
  candidateBytes: number | null;
  lightKeptOriginal: boolean;
  lightNeedsDeep: boolean;
  targetBytes: number | null;
  deepReason?: string;
}
export interface RouteDecision {
  useDeep: boolean;
  qpdfOnly: boolean;
  reason: string;
}

/** Preserve UI mode names while routing internally to the safest available engine. */
export function decideCompressionRoute(input: RouteDecisionInput): RouteDecision {
  const targetUnmet = input.targetBytes !== null &&
    (input.candidateBytes === null || input.candidateBytes > input.targetBytes);
  const qpdfOnly = /AcroForm|interactive form/i.test(input.deepReason ?? "");
  const useDeep = input.lightNeedsDeep || input.lightKeptOriginal || input.candidateBytes === null || targetUnmet;
  if (qpdfOnly) return { useDeep: true, qpdfOnly: true, reason: "Interactive form requires lossless QPDF-only processing." };
  if (targetUnmet) return { useDeep: true, qpdfOnly: false, reason: "Custom target was not reached by the light engine." };
  if (input.lightNeedsDeep) return { useDeep: true, qpdfOnly: false, reason: input.deepReason ?? "Light engine requested a deeper route." };
  if (input.lightKeptOriginal || input.candidateBytes === null) return { useDeep: true, qpdfOnly: false, reason: "No smaller light-engine candidate was certified." };
  return { useDeep: false, qpdfOnly: false, reason: "The light-engine candidate is smaller and satisfies the current policy." };
}
