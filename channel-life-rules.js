export function compressionFinding(q, label) {
  if (q == null || q < 29) return null;
  return { level: 'warn', title: 'Compresión exigente', detail: `Q promedio ${q} con ${label}. Puede haber menos detalle en escenas difíciles; este dato no demuestra mala recepción ni congelamientos. Compara Normal y Normal Mejorado Pro a 2000 kbps en Laboratorio; Clásico 480p · 1000 es solo experimental.` };
}
export function labSuggestion({ slug, running, q, speed }) {
  if (!['futv', 'fox'].includes(slug) || !running || !(q >= 29 || (speed != null && speed < 0.95))) return null;
  return { channel: slug, reason: 'Conviene comparar una muestra reciente con las cinco salidas, sin cambiar el canal.', seconds: 120 };
}
export function normalizeHistoricalProfile(profile, catalog, aliases) {
  const key = aliases[profile] || profile;
  return Object.hasOwn(catalog, key) ? key : null;
}