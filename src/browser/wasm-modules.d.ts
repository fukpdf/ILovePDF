declare module "@jspawn/ghostscript-wasm" {
  interface GhostscriptModuleOptions {
    locateFile?: (path: string, prefix?: string) => string;
    noInitialRun?: boolean;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }
  interface GhostscriptModule {
    FS: {
      writeFile(path: string, data: Uint8Array): void;
      readFile(path: string): Uint8Array;
      unlink(path: string): void;
      analyzePath?(path: string): { exists: boolean };
    };
    callMain(args: string[]): number;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }
  const createGhostscript: (options: GhostscriptModuleOptions) => Promise<GhostscriptModule>;
  export default createGhostscript;
}

declare module "@neslinesli93/qpdf-wasm" {
  interface QpdfModuleOptions {
    locateFile: (path: string, prefix?: string) => string;
    noInitialRun?: boolean;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }
  interface QpdfModule {
    FS: {
      writeFile(path: string, data: Uint8Array): void;
      readFile(path: string): Uint8Array;
      unlink(path: string): void;
      analyzePath?(path: string): { exists: boolean };
    };
    callMain(args: string[]): number;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }
  const createQpdf: (options: QpdfModuleOptions) => Promise<QpdfModule>;
  export default createQpdf;
}
