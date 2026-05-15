{pkgs}: {
  deps = [
    pkgs.pkg-config
    pkgs.gcc
    pkgs.gnumake
    pkgs.python3
    pkgs.imagemagick
    pkgs.wrangler_1
    pkgs.firebase-tools
    pkgs.ghostscript
    pkgs.qpdf
  ];
}
