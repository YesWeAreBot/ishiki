declare module "jpeg-js" {
  interface DecodeOptions {
    useTArray?: boolean;
    formatAsRGBA?: boolean;
    maxMemoryUsageInMB?: number;
  }

  interface EncodeOptions {
    quality?: number;
    formatAsRGBA?: boolean;
  }

  interface RawImage {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export function decode(buffer: Uint8Array, options?: DecodeOptions): RawImage;
  export function encode(image: RawImage, quality?: number): { data: Buffer; width: number; height: number };
}
