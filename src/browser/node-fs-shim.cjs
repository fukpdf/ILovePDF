const unsupported = () => {
  throw new Error("Node filesystem APIs are unavailable in the browser compression bundle.");
};
module.exports = {
  readFileSync: unsupported,
  writeFileSync: unsupported,
  existsSync: unsupported,
  statSync: unsupported,
  openSync: unsupported,
  closeSync: unsupported,
  readSync: unsupported,
  writeSync: unsupported,
  unlinkSync: unsupported,
  mkdirSync: unsupported,
  readdirSync: unsupported,
  createReadStream: unsupported,
  createWriteStream: unsupported,
};
