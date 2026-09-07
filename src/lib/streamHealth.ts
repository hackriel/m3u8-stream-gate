// Criterio único de estabilidad para las tarjetas de canal (Home "Señales
// activas" y pantalla pública Uptime).
//
// FILOSOFÍA (v2): un dato aislado NO define la salud de un canal. FFmpeg
// reporta FPS/speed/Q como muestras instantáneas que oscilan por diseño
// (arranque, cambio de segmento HLS, escena compleja). Evaluar cada muestra
// suelta producía saltos SANO→INESTABLE→ATENCIÓN en segundos, que asustan sin
// representar nada que el cliente perciba.
//
// Por eso ahora:
//   1. Se promedia (mediana) una ventana de ~60s, no la última muestra.
//   2. Los umbrales son los que la industria considera realmente problemáticos.
//   3. Hay histéresis: subir de severidad exige 3 evaluaciones seguidas malas;
//      bajar exige 6 buenas. Nada cambia por un pico de 1 segundo.
//   4. Las recuperaciones solo pesan si son RECIENTES (últimos 10 min), no el
//      acumulado histórico del canal.
//   5. Los primeros 25s de un proceso son "arranque": nunca se marca crítico.
//
// DUP/DROP acumulados NO se usan: en fuentes HLS scrapeadas son ajustes de
// cadencia normales y no indican pérdida real de señal.

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

// ---- Umbrales (sobre valores medianos de la ventana, no instantáneos) ----
const FPS_CRIT = 15;
const FPS_WARN = 22;
const SPEED_CRIT_LO = 0.85;
const SPEED_CRIT_HI = 1.25;
const SPEED_WARN_LO = 0.92;
const SPEED_WARN_HI = 1.12;
const Q_CRIT = 36;
const Q_WARN = 31;

const WINDOW_MS = 60_000;
const WARMUP_MS = 25_000;
const RECOVERY_WINDOW_MS = 10 * 60_000;
const ESCALATE_SAMPLES = 3;
const DEESCALATE_SAMPLES = 6;

interface Sample {
  ts: number;
  fps: number | null;
  speed: number | null;
  q: number | null;
}

interface HistoryBucket {
  /** Marca de inicio del bucket (múltiplo de BUCKET_MS). */
  ts: number;
  /** Peor nivel observado dentro del bucket. */
  level: HealthLevel;
}

interface ChannelState {
  samples: Sample[];
  firstTs: number;
  level: HealthLevel;
  pendingLevel: HealthLevel | null;
  pendingCount: number;
  recoveryMarks: number[];
  lastRecoveryCount: number;
  lastStatus: string;
  history: HistoryBucket[];
}

/** Cada barra del historial resume 30 segundos. */
export const BUCKET_MS = 30_000;
/** 30 barras = últimos 15 minutos de comportamiento. */
export const HISTORY_BUCKETS = 30;

const states = new Map<string, ChannelState>();

const median = (arr: number[]): number | null => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const severity = (l: HealthLevel) => (l === "critical" ? 2 : l === "warning" ? 1 : 0);

/** Evaluación puntual (sin suavizado) — se mantiene por compatibilidad. */
export function computeStreamHealth(input: HealthInput): HealthResult {
  const { status, recoveryCount, passthrough } = input;
  const fps = passthrough ? null : input.fps;
  const speed = passthrough ? null : input.speed;
  const q = passthrough ? null : input.q;
  return evaluate({ status, fps, speed, q, recentRecoveries: recoveryCount > 0 ? 1 : 0, warmup: false });
}

/**
 * Evaluación suavizada y con histéresis. `key` identifica el canal (pid).
 * Debe llamarse en cada refresco de telemetría (cada ~2–5s).
 */
export function computeStreamHealthSmoothed(key: string, input: HealthInput): HealthResult {
  const now = Date.now();
  const passthrough = !!input.passthrough;
  let st = states.get(key);
  if (!st) {
    st = {
      samples: [],
      firstTs: now,
      level: "stable",
      pendingLevel: null,
      pendingCount: 0,
      recoveryMarks: [],
      lastRecoveryCount: input.recoveryCount,
      lastStatus: input.status,
      history: [],
    };
    states.set(key, st);
  }

  // Reinicio de ventana cuando el proceso arranca de nuevo
  if (st.lastStatus !== input.status && input.status === "running") {
    st.samples = [];
    st.firstTs = now;
    st.pendingLevel = null;
    st.pendingCount = 0;
  }
  st.lastStatus = input.status;

  // Recuperaciones recientes
  if (input.recoveryCount > st.lastRecoveryCount) {
    for (let i = 0; i < input.recoveryCount - st.lastRecoveryCount; i++) st.recoveryMarks.push(now);
  }
  st.lastRecoveryCount = input.recoveryCount;
  st.recoveryMarks = st.recoveryMarks.filter((t) => now - t < RECOVERY_WINDOW_MS);

  st.samples.push({
    ts: now,
    fps: passthrough ? null : input.fps,
    speed: passthrough ? null : input.speed,
    q: passthrough ? null : input.q,
  });
  st.samples = st.samples.filter((s) => now - s.ts <= WINDOW_MS);

  const num = (pick: (s: Sample) => number | null) =>
    median(st!.samples.map(pick).filter((v): v is number => v != null && v > 0));

  const raw = evaluate({
    status: input.status,
    fps: num((s) => s.fps),
    speed: num((s) => s.speed),
    q: num((s) => s.q),
    recentRecoveries: st.recoveryMarks.length,
    warmup: now - st.firstTs < WARMUP_MS,
  });

  // Histéresis
  if (raw.level === st.level) {
    st.pendingLevel = null;
    st.pendingCount = 0;
  } else {
    if (st.pendingLevel !== raw.level) {
      st.pendingLevel = raw.level;
      st.pendingCount = 0;
    }
    st.pendingCount++;
    const needed = severity(raw.level) > severity(st.level) ? ESCALATE_SAMPLES : DEESCALATE_SAMPLES;
    if (st.pendingCount >= needed) {
      st.level = raw.level;
      st.pendingLevel = null;
      st.pendingCount = 0;
    }
  }

  return { level: st.level, label: LABELS[st.level], reasons: raw.reasons };
}

function evaluate(args: {
  status: string;
  fps: number | null;
  speed: number | null;
  q: number | null;
  recentRecoveries: number;
  warmup: boolean;
}): HealthResult {
  const { status, fps, speed, q, recentRecoveries, warmup } = args;
  const critical: string[] = [];
  const warning: string[] = [];

  if (status !== "running") warning.push(`Estado del proceso: ${status}`);
  if (fps != null) {
    if (fps < FPS_CRIT) critical.push(`FPS ${fps.toFixed(1)} sostenido (crítico: < ${FPS_CRIT})`);
    else if (fps < FPS_WARN) warning.push(`FPS ${fps.toFixed(1)} sostenido (aviso: < ${FPS_WARN})`);
  }
  if (speed != null) {
    if (speed < SPEED_CRIT_LO || speed > SPEED_CRIT_HI)
      critical.push(`Velocidad ${speed.toFixed(2)}x sostenida (crítico: fuera de ${SPEED_CRIT_LO}–${SPEED_CRIT_HI})`);
    else if (speed < SPEED_WARN_LO || speed > SPEED_WARN_HI)
      warning.push(`Velocidad ${speed.toFixed(2)}x sostenida (aviso: fuera de ${SPEED_WARN_LO}–${SPEED_WARN_HI})`);
  }
  if (q != null) {
    if (q >= Q_CRIT) critical.push(`Q ${q.toFixed(1)} medio (crítico: >= ${Q_CRIT}, compresión al límite)`);
    else if (q >= Q_WARN) warning.push(`Q ${q.toFixed(1)} medio (aviso: >= ${Q_WARN}, sube el perfil de salida)`);
  }
  if (recentRecoveries >= 3) critical.push(`${recentRecoveries} recuperaciones en los últimos 10 min`);
  else if (recentRecoveries > 0)
    warning.push(`${recentRecoveries} recuperación${recentRecoveries === 1 ? "" : "es"} reciente${recentRecoveries === 1 ? "" : "s"}`);

  let level: HealthLevel = critical.length > 0 ? "critical" : warning.length > 0 ? "warning" : "stable";
  if (warmup && level === "critical") level = "warning"; // arranque: no alarmar
  const reasons = critical.length > 0 ? critical.concat(warning) : warning;
  return { level, label: LABELS[level], reasons };
}

export function healthTooltip(result: HealthResult, passthrough = false): string {
  const criteria =
    "Criterio (mediana de 60s, no valores instantáneos): FPS (>=22 sano, <15 crítico) · Velocidad (0.92–1.12 sano, fuera de 0.85–1.25 crítico) · Q de compresión (<31 sano, >=36 crítico) · recuperaciones de los últimos 10 min. Un cambio de estado exige ~3 lecturas seguidas; los picos de 1 segundo se ignoran.";
  if (result.level === "stable") {
    return passthrough
      ? `Sano — passthrough (-c copy): sin re-encode, no hay FPS/Q que evaluar. ${criteria}`
      : `Sano — FPS, velocidad y compresión dentro de rango. ${criteria}`;
  }
  return `${result.label}: ${result.reasons.join(" · ")}. ${criteria}`;
}
