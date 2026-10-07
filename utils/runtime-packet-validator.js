export function packetValidatorSoft(req, res, next) {
  // Soft packet validator: logs anomalies without blocking requests
  if (req.method === 'POST' && req.body && typeof req.body === 'object') {
    const keys = Object.keys(req.body);
    if (keys.length > 50) {
      console.warn('[packetValidatorSoft] Large payload key count detected:', keys.length, req.path);
    }
  }
  next();
}

export default packetValidatorSoft;
