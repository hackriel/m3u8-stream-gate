// All known output channels must be included in bulk status, including new tabs.
export function trackedProcessIds(slugMap, minimumMax = 26) {
  const maximum = Math.max(minimumMax, ...Object.keys(slugMap).map(Number).filter(Number.isFinite));
  return Array.from({ length: maximum + 1 }, (_, i) => String(i));
}