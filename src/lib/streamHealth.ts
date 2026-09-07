// Criterio único de estabilidad para las tarjetas de canal (Home "Señales
// activas" y pantalla pública Uptime). Se basa SOLO en telemetría en vivo de
// FFmpeg (/api/status) + recuperaciones persistidas en la base de datos.
//
// Reglas (en orden de severidad):
//   INESTABLE (crítico): estado ≠ running, FPS < 20, speed < 0.90 o > 1.15,
//                        Q >= 32, o más de 5 recuperaciones acumuladas.
//   ATENCIÓN (aviso):    FPS < 25, speed < 0.95 o > 1.05, Q >= 28,
//                        o al menos 1 recuperación acumulada.
//   SANO:                todo dentro de rango.
//
// DUP/DROP acumulados NO se usan como criterio: en fuentes HLS scrapeadas son
// ajustes de cadencia normales y no indican pérdida real de señal.

export type HealthLevel = "stable" | "warning" | "critical";

export interface HealthInput {
  status: string;
  fps: number | null;
  speed: number | null;
  q: number | null;
  recoveryCount: number;
  /** Passthrough (-c copy): FFmpeg no decodifica, fps/q/speed no aplican. */
  passthrough?: boolean;
}

export interface HealthResult {
  level: HealthLevel;
  label: string;
  reasons: string[];
}

const LABELS: Record<HealthLevel, string> = {
  stable: "SANO",
  warning: "ATENCIÓN",
  critical: "INESTABLE",
};

export function computeStreamHealth(input: HealthInput): HealthResult {
  const { status, recoveryCount, passthrough } = input;
  const fps = passthrough ? null : input.fps;
  const speed = passthrough ? null : input.speed;
  const q = passthrough ? null : input.q;

  const critical: string[] = [];
  const warning: string[] = [];

  if (status !== "running") warning.push(`Estado del proceso: ${status}`);
  if (fps != null && fps > 0) {
    if (fps < 20) critical.push(`FPS ${fps.toFixed(1)} (crítico: < 20)`);
    else if (fps < 25) warning.push(`FPS ${fps.toFixed(1)} (aviso: < 25)`);
  }
  if (speed != null) {
    if (speed < 0.9 || speed > 1.15) critical.push(`Velocidad ${speed.toFixed(2)}x (crítico: fuera de 0.90–1.15)`);
    else if (speed < 0.95 || speed > 1.05) warning.push(`Velocidad ${speed.toFixed(2)}x (aviso: fuera de 0.95–1.05)`);
  }
  if (q != null && q > 0) {
    if (q >= 32) critical.push(`Q ${q.toFixed(1)} (crítico: >= 32, compresión al límite)`);
    else if (q >= 28) warning.push(`Q ${q.toFixed(1)} (aviso: >= 28)`);
  }
  if (recoveryCount > 5) critical.push(`${recoveryCount} recuperaciones acumuladas (crítico: > 5)`);
  else if (recoveryCount > 0) warning.push(`${recoveryCount} recuperación${recoveryCount === 1 ? "" : "es"} acumulada${recoveryCount === 1 ? "" : "s"}`);

  const level: HealthLevel = critical.length > 0 ? "critical" : warning.length > 0 ? "warning" : "stable";
  const reasons = critical.length > 0 ? critical.concat(warning) : warning;
  return { level, label: LABELS[level], reasons };
}

export function healthTooltip(result: HealthResult, passthrough = false): string {
  const criteria =
    "Criterio: FPS (>=25 sano, <20 crítico) · Velocidad (0.95–1.05 sano, fuera de 0.90–1.15 crítico) · Q de compresión (<28 sano, >=32 crítico) · recuperaciones automáticas del canal.";
  if (result.level === "stable") {
    return passthrough
      ? `Sano — passthrough (-c copy): sin re-encode, no hay FPS/Q que evaluar. ${criteria}`
      : `Sano — FPS, velocidad y compresión dentro de rango. ${criteria}`;
  }
  return `${result.label}: ${result.reasons.join(" · ")}. ${criteria}`;
}
