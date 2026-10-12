export function requestTimingMiddleware() {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      req._duration = Date.now() - start;
    });
    next();
  };
}

export function getHealthSnapshot() {
  const mem = process.memoryUsage();
  return {
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
  };
}
