declare module "jpeg-js" {
  export interface DecodedImage {
    data: Uint8Array;
    width: number;
    height: number;
  }
  export interface EncodedImage {
    data: Uint8Array;
    width: number;
    height: number;
  }
  export function decode(
    bytes: Uint8Array,
    options?: { useTArray?: boolean; formatAsRGBA?: boolean; tolerantDecoding?: boolean; maxMemoryUsageInMB?: number },
  ): DecodedImage;
  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): EncodedImage;
}
