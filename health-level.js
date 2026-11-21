// Criterio de nivel de salud que usa el VPS para las barras de 15 min.
// Mantener alineado con src/lib/streamHealth.ts (panel).
//
// La salud mide CONTINUIDAD de la emisión: proceso vivo, imágenes por segundo,
// ritmo de procesamiento y recuperaciones recientes. Q de x264 indica cuánto
// comprime el encoder (sube con césped, público, lluvia, gráficos) y NO es
// evidencia de recepción o entrega defectuosa, por eso nunca cambia el nivel.
export const Q_HIGH_NOTE = 31;

export function classifyHealth({ status, fps, speed, q, recentRecoveries = 0, warmup = false }) {
  const critical = [];
  const warning = [];
  const notes = [];
  if (status !== 'running') warning.push('status');
  if (fps != null) { if (fps < 15) critical.push('fps'); else if (fps < 22) warning.push('fps'); }
  if (speed != null) {
    if (speed < 0.85 || speed > 1.25) critical.push('speed');
    else if (speed < 0.92 || speed > 1.12) warning.push('speed');
  }
  if (recentRecoveries >= 3) critical.push('recoveries');
  else if (recentRecoveries > 0) warning.push('recoveries');
  if (q != null && q >= Q_HIGH_NOTE) notes.push('q');
  let level = critical.length ? 'critical' : warning.length ? 'warning' : 'stable';
  if (warmup && level === 'critical') level = 'warning';
  return { level, notes };
}
