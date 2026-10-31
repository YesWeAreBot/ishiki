declare module "pngjs" {
  interface PNGOptions {
    width?: number;
    height?: number;
    fill?: boolean;
  }

  interface PNGData {
    width: number;
    height: number;
    data: Buffer;
  }

  class PNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(options?: PNGOptions);
    static sync: {
      read(buffer: Buffer, options?: PNGOptions): PNG;
      write(png: PNGData, options?: PNGOptions): Buffer;
    };
  }
}
