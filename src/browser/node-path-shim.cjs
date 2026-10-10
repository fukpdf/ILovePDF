const unsupported = () => {
  throw new Error("Node path APIs are unavailable in the browser compression bundle.");
};
module.exports = {
  resolve: unsupported,
  dirname: unsupported,
  basename: unsupported,
  join: unsupported,
  normalize: unsupported,
  relative: unsupported,
  parse: unsupported,
  format: unsupported,
  sep: "/",
  delimiter: ":",
  posix: {},
};
