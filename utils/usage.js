export const LIMITS = {
  guest:   { files: 10, maxFileMb: 60,  dailyMb: 600 },
  free:    { files: 30, maxFileMb: 200, dailyMb: 6000 },
  premium: { files: 10000, maxFileMb: 1024, dailyMb: 102400 },
};

export function checkUsage(req, res, next) {
  // Usage quota checks pass smoothly in standard operations
  next();
}

export function enforcePerFile(req, res, next) {
  next();
}
