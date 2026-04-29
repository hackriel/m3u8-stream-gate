import express from 'express';
import cors from 'cors';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import net from 'net';
import http from 'http';
import https from 'https';
import { createClient } from '@supabase/supabase-js';

// Tigo (ID 12) descartado. Se mantienen solo compat-shims mínimos para no romper cleanup legado.
const tigoProxies = new Map();
const stopTigoProxy = async (_process_id) => {};


// Configurar cliente de Supabase (opcional, solo si hay variables de entorno)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('✅ Cliente de Supabase inicializado correctamente.');
} else {
  console.warn('⚠️ Supabase no está configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Se desactivan logs persistentes en base de datos.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurar multer para subida de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB max
});

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// WebSocket server para logs en tiempo real
const wss = new WebSocketServer({ server, path: '/ws' });
const connectedClients = new Set();

wss.on('connection', (ws) => {
  console.log('🔌 Cliente conectado al sistema de logs');
  connectedClients.add(ws);
  
  // Enviar log de bienvenida
  sendLog('system', 'info', 'Cliente conectado al sistema de logs en tiempo real');
  
  ws.on('close', () => {
    console.log('🔌 Cliente desconectado del sistema de logs');
    connectedClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    console.error('❌ Error en WebSocket:', error);
    connectedClients.delete(ws);
  });
});

// ============= BUFFER CIRCULAR DE LOGS POR PROCESO (snapshots forenses) =============
// Mantiene las últimas N líneas de log "ricas" (level + mensaje + details)
// por cada processId. Se vuelca a Supabase (process_log_snapshots) cuando
// el proceso termina (close handler) o se detiene manualmente.
const recentLogsBuffer = new Map(); // pid (string) -> string[]
const LOG_SNAPSHOT_LINES = 100;

// Guarda un snapshot del log actual del proceso en Supabase.
// La rotación a 3 snapshots por proceso la hace un trigger en la DB.
async function saveLogSnapshot(processId, reason) {
  if (!supabase) return;
  const pid = String(processId);
  const buf = recentLogsBuffer.get(pid) || [];
  if (buf.length === 0) return; // nada que guardar
  const logContent = buf.join('\n');
  try {
    // Traer estado actual del proceso para enriquecer el snapshot
    let emit_status = null, emit_msg = null, failure_reason = null, failure_details = null;
    try {
      const { data } = await supabase
        .from('emission_processes')
        .select('emit_status, emit_msg, failure_reason, failure_details')
        .eq('id', Number(pid))
        .maybeSingle();
      if (data) {
        emit_status = data.emit_status;
        emit_msg = data.emit_msg;
        failure_reason = data.failure_reason;
        failure_details = data.failure_details;
      }
    } catch {}
    await supabase.from('process_log_snapshots').insert({
      process_id: Number(pid),
      reason: String(reason).slice(0, 200),
      log_content: logContent,
      emit_status,
      emit_msg,
      failure_reason,
      failure_details,
    });
  } catch (e) {
    console.error(`[snapshot] Error guardando para pid=${pid}:`, e?.message || e);
  }
}

// Función para enviar logs a todos los clientes conectados
const sendLog = (processId, level, message, details = null) => {
  const logData = {
    id: Date.now() + Math.random().toString(),
    timestamp: Date.now(),
    processId,
    level,
    message,
    details
  };
  
  const logMessage = JSON.stringify(logData);
  
  // ── Buffer circular de últimos 100 logs por proceso (para snapshots forenses) ──
  try {
    const pid = String(processId);
    if (!recentLogsBuffer.has(pid)) recentLogsBuffer.set(pid, []);
    const buf = recentLogsBuffer.get(pid);
    const ts = new Date(logData.timestamp).toISOString();
    const detailsStr = details ? ` | ${typeof details === 'string' ? details : JSON.stringify(details)}` : '';
    buf.push(`[${ts}] [${String(level).toUpperCase()}] ${message}${detailsStr}`);
    if (buf.length > LOG_SNAPSHOT_LINES) buf.shift();
  } catch (e) {
    // No romper sendLog por un error de buffer
  }

  connectedClients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(logMessage);
      } catch (e) {
        console.error('Error enviando log a cliente:', e);
        connectedClients.delete(client);
      }
    }
  });
};

// Función para enviar notificación de fallo específico
const sendFailureNotification = (processId, failureType, details) => {
  const failureData = {
    type: 'failure',
    processId,
    failureType, // 'source', 'rtmp', 'server'
    timestamp: Date.now(),
    details
  };
  
  const message = JSON.stringify(failureData);
  
  connectedClients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (e) {
        console.error('Error enviando notificación de fallo:', e);
        connectedClients.delete(client);
      }
    }
  });
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// ===== HLS OUTPUT: Directorio para segmentos HLS locales =====
const HLS_OUTPUT_DIR = path.join(__dirname, 'live');
if (!fs.existsSync(HLS_OUTPUT_DIR)) {
  fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}
// Servir segmentos HLS con headers correctos para XUI/IPTV
app.use('/live', (req, res, next) => {
  // CORS permisivo para reproductores IPTV
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  // Cache headers para HLS: segmentos .ts se cachean, playlist .m3u8 no
  if (req.path.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (req.path.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=30');
  }
  next();
}, express.static(HLS_OUTPUT_DIR));

// Variables globales para manejo de múltiples procesos ffmpeg
const ffmpegProcesses = new Map(); // Map<processId, { process, status, startTime, target_rtmp }>
const emissionStatuses = new Map(); // Map<processId, status>
const autoRecoveryInProgress = new Map(); // Map<processId(string), boolean>
const manualStopProcesses = new Set(); // Procesos detenidos manualmente (no hacer auto-recovery)
const nightRestStoppedProcesses = new Set(); // Procesos apagados por descanso nocturno
const detectedErrors = new Map(); // Map<processId, { type, reason }> — último error detectado por stderr

// === CIRCUIT BREAKER: evita loops infinitos de recovery que saturan el servidor ===
// Registra timestamps de cada fallo para detectar "tormenta de caídas"
const failureTimestamps = new Map(); // Map<processId(string), number[]>
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const CIRCUIT_BREAKER_MAX_FAILURES = 6; // máx 6 caídas en 10 min → detener

const isCircuitBroken = (processId) => {
  const key = String(processId);
  const timestamps = failureTimestamps.get(key) || [];
  const now = Date.now();
  // Limpiar timestamps fuera de la ventana
  const recent = timestamps.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
  failureTimestamps.set(key, recent);
  return recent.length >= CIRCUIT_BREAKER_MAX_FAILURES;
};

const recordFailure = (processId) => {
  const key = String(processId);
  const timestamps = failureTimestamps.get(key) || [];
  timestamps.push(Date.now());
  failureTimestamps.set(key, timestamps);
};

const resetCircuitBreaker = (processId) => {
  failureTimestamps.delete(String(processId));
};

// === CONCURRENCY LIMITER: máx 2 recoveries simultáneos para no saturar CPU/red ===
let activeRecoveryCount = 0;
const MAX_CONCURRENT_RECOVERIES = 2;
const recoveryQueue = []; // Queue<{ fn: () => Promise<void>, processId: string }>

const enqueueRecovery = (processId, fn) => {
  const key = String(processId);
  // Si ya hay un recovery encolado para este proceso, ignorar
  if (recoveryQueue.some(item => item.processId === key)) {
    sendLog(processId, 'warn', '⏳ Recovery ya encolado, ignorando duplicado');
    return;
  }
  if (activeRecoveryCount < MAX_CONCURRENT_RECOVERIES) {
    activeRecoveryCount++;
    fn().catch(err => {
      console.error(`Recovery error (process ${key}):`, err.message);
    }).finally(() => {
      activeRecoveryCount--;
      processRecoveryQueue();
    });
  } else {
    sendLog(processId, 'info', `⏳ Recovery encolado (${activeRecoveryCount} activos, esperando turno...)`);
    recoveryQueue.push({ processId: key, fn });
  }
};

const processRecoveryQueue = () => {
  while (recoveryQueue.length > 0 && activeRecoveryCount < MAX_CONCURRENT_RECOVERIES) {
    const next = recoveryQueue.shift();
    // Verificar que no se haya cancelado manualmente mientras esperaba
    if (manualStopProcesses.has(next.processId) || manualStopProcesses.has(Number(next.processId))) {
      sendLog(next.processId, 'info', '🛑 Recovery encolado cancelado: parada manual durante espera en cola');
      continue;
    }
    activeRecoveryCount++;
    next.fn().catch(err => {
      console.error(`Queued recovery error (process ${next.processId}):`, err.message);
    }).finally(() => {
      activeRecoveryCount--;
      processRecoveryQueue();
    });
  }
};


// FUTV Auto-recovery: obtener nueva URL y reiniciar emisión
const SUPABASE_FUNCTIONS_URL = `https://${(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace('https://', '').replace(/\/$/, '')}/functions/v1`;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

// Mapa de canales scrapeados (definido una sola vez, usado en recovery y drop-signal)
const CHANNEL_MAP = {
  '1': { channelId: '641cba02e4b068d89b2344e3', channelName: 'FUTV' },
  '3': { channelId: '66608d188f0839b8a740cfe9', channelName: 'TDmas 1' },
  '4': { channelId: '617c2f66e4b045a692106126', channelName: 'Teletica' },
  
  '6': { channelId: '664e5de58f089fa849a58697', channelName: 'Multimedios' },
  '11': { channelId: '641cba02e4b068d89b2344e3', channelName: 'FUTV URL' },
  '13': { channelId: '617c2f66e4b045a692106126', channelName: 'TELETICA URL' },
  '14': { channelId: '66608d188f0839b8a740cfe9', channelName: 'TDMAS 1 URL' },
};

// Procesos que emiten a HLS local en vez de RTMP
const HLS_OUTPUT_PROCESSES = new Set(['11', '12', '13', '14', '15', '16', '17', '18', '19']);
// Mapa de slug HLS por proceso (para la ruta /live/<slug>/playlist.m3u8)
// FUTV (11), FUTV ALTERNO (17) y FUTV SRT (18) comparten slug 'futv' a propósito:
// los 3 emiten al MISMO destino HLS local (/live/futv/playlist.m3u8) por métodos distintos
// (scraping, URL manual, SRT desde OBS). El bloqueo mutuo de slug evita que se pisen entre sí
// — el usuario decide cuál de los 3 está activo en cada momento.
// Disney 7 SRT (16) y RANDOM Disney 7 (19) también comparten slug 'Disney7' por la
// misma razón: los 2 emiten al mismo destino /live/Disney7/playlist.m3u8 por métodos
// distintos (SRT desde OBS vs M3U passthrough). Mutuamente excluyentes.
const HLS_SLUG_MAP = { '11': 'futv', '12': 'Tigo', '13': 'Teletica', '14': 'Tdmas1', '15': 'Canal6', '16': 'Disney7', '17': 'futv', '18': 'futv', '19': 'Disney7' };

// ───────────────────────────────────────────────────────────────────────
// PROXY SOCKS5 (Pi 5 residencial Costa Rica) — usado SOLO para Tigo (ID 12)
// El proxy enruta tanto el scraping (login/token TDMax) como el consumo
// FFmpeg (manifiesto + segmentos HLS) por la IP residencial CR para
// evitar el geobloqueo y la validación de IP del CDN de Tigo.
// ───────────────────────────────────────────────────────────────────────
const TIGO_PROXY_URL = process.env.TIGO_PROXY_URL || 'socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080';
// IDs de proceso que deben enrutar TODO su tráfico (scraping + FFmpeg) por el proxy
const PROXY_PROCESSES = new Set();
// Comando proxychains4 (instalable con: apt install -y proxychains4)
// Config dinámica generada en /tmp para no chocar con instalación global
const PROXYCHAINS_CONF_PATH = '/tmp/proxychains-tigo.conf';

// ── Pool de User-Agents reales (Fase 1: rotación de identidad por sesión) ──
// Cada vez que arranca/reinicia un proceso con proxy (Tigo), se elige uno
// aleatorio. Esto evita que Wowza/Nimble nos identifique como el mismo
// "cliente persistente" entre reconexiones consecutivas.
const REAL_USER_AGENTS = [
  // Chrome Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // Chrome macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Edge Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  // Safari macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  // Firefox Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
];
const pickRandomUserAgent = () => REAL_USER_AGENTS[Math.floor(Math.random() * REAL_USER_AGENTS.length)];

// Cache del agent SOCKS5 para reutilizar conexiones HTTP/HTTPS.
// Compat shim: evita referencia rota a SocksProxyAgent si alguna ruta legado se invoca por error.
const getProxyAgent = () => undefined;

// ── Keep-alive del playlist Tigo (Opción B) ──────────────────────────
// Wowza/Nimble cierra `nimblesessionid` por idle (~30-60s). FFmpeg pide el
// playlist cada ~6s, pero si el SOCKS5 jitterea y se salta un poll, el CDN
// marca la sesión como muerta → micro-corte de 2-3s en el TV.
// Hacemos GET paralelo cada 25s al MISMO playlist (variant pinned) vía la
// MISMA IP (proxychains4/SOCKS5) para mantener la sesión caliente.
// El resultado se descarta — solo importa que el CDN vea actividad.
const tigoKeepAliveIntervals = new Map(); // process_id → intervalId

const startTigoKeepAlive = (process_id, playlistUrl, userAgent) => {
  // Limpiar interval previo si existe (recovery/restart)
  stopTigoKeepAlive(process_id);
  if (!playlistUrl) return;

  const tick = async () => {
    try {
      const resp = await fetchWithOptionalProxy(playlistUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent || 'Mozilla/5.0',
          'Referer': 'https://www.teletica.com/',
          'Origin': 'https://www.teletica.com',
          'Accept': '*/*',
        },
        signal: AbortSignal.timeout(8000),
      }, true);
      if (resp.status === 403) {
        sendLog(process_id, 'warn', `🔑 KeepAlive: token expirado (403) — FFmpeg refrescará`);
      } else if (resp.status === 404) {
        sendLog(process_id, 'warn', `🔄 KeepAlive: sesión rotada (404) — playlist obsoleto`);
      } else if (!resp.ok) {
        sendLog(process_id, 'warn', `⚠️ KeepAlive: HTTP ${resp.status}`);
      }
      // status 200 = silencio (no contaminar logs)
    } catch (err) {
      // timeout/jitter: silencioso (esperado ocasionalmente con SOCKS5 residencial)
    }
  };

  // Primer tick a los 25s (no inmediato: FFmpeg ya hizo el primer GET)
  const intervalId = setInterval(tick, 25000);
  tigoKeepAliveIntervals.set(String(process_id), intervalId);
  sendLog(process_id, 'info', `💓 KeepAlive playlist activado (cada 25s vía Pi5)`);
};

const stopTigoKeepAlive = (process_id) => {
  const id = tigoKeepAliveIntervals.get(String(process_id));
  if (id) {
    clearInterval(id);
    tigoKeepAliveIntervals.delete(String(process_id));
  }
};

// ── Buffer HLS local Tigo (Opción 1, Apr 2026) ─────────────────────
// Cadena de 2 etapas para absorber micro-cortes sin afectar al TV.
//
// MODO HDMI (default — Apr 2026): la ETAPA 1 es un FFmpeg SRT listener que
// recibe video del Pi5 (Tigo Stick → Cam Link 4K → FFmpeg HDMI→SRT). NO se
// usa el CDN de Tigo para nada. Cero scraping, cero tokens.
//
// MODO PROXY (legacy/fallback): ETAPA 1 = FFmpeg con proxychains → CDN HLS.
// Se activa con TIGO_USE_HDMI=false. Microsocks del Pi5 sigue vivo.
//
// En ambos modos la ETAPA 2 es idéntica: FFmpeg #2 lee buf.m3u8 con -re y
// transcodea 720p CBR 2000k → /live/Tigo/playlist.m3u8 (lo que el TV consume).
// Reversible con TIGO_USE_BUFFER=false (vuelve a modo single-FFmpeg legacy).
const TIGO_USE_BUFFER = (process.env.TIGO_USE_BUFFER || 'true').toLowerCase() !== 'false';
const TIGO_USE_HDMI = false; // Descartado definitivamente
const TIGO_SRT_PORT = parseInt(process.env.TIGO_SRT_PORT || '9000', 10);
const TIGO_SRT_LATENCY_MS = parseInt(process.env.TIGO_SRT_LATENCY_MS || '2000', 10);
const TIGO_SRT_LATENCY_US = TIGO_SRT_LATENCY_MS * 1000;
const TIGO_BUFFER_DIR = '/tmp/tigo-buffer-12';
const TIGO_BUFFER_PLAYLIST = path.join(TIGO_BUFFER_DIR, 'buf.m3u8');
const TIGO_BUFFER_MIN_SEGMENTS = 3; // HDMI no tiene jitter de CDN, 3 segs = ~30s buffer
const TIGO_BUFFER_WAIT_TIMEOUT_MS = 60000; // Máx 60s esperando primer buffer

// ── Disney 7 (ID 16) SRT INGEST desde OBS ──────────────────────────
// ── SRT INGEST genérico (OBS → VPS) ────────────────────────────────
// Patrón unificado para procesos que reciben señal SRT desde OBS:
//   Disney 7 (ID 16, puerto 9001), Tigo (ID 12, puerto 9000),
//   FUTV SRT (ID 18, puerto 9002).
// Para activar: OBS apunta a srt://VPS_IP:<port>?streamid=<id>&passphrase=...
// Cuando el dashboard arranca un proceso SRT sin URL de origen, el sistema
// arranca automáticamente el listener SRT en su puerto correspondiente.
const SRT_INGEST_CONFIGS = {
  '12': {
    label: 'TIGO SRT',
    slug: 'Tigo',
    port: parseInt(process.env.TIGO_SRT_PORT || '9000', 10),
    latencyMs: parseInt(process.env.TIGO_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.TIGO_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/tigo-srt-buffer-12',
  },
  '16': {
    label: 'DISNEY 7 SRT',
    slug: 'Disney7',
    port: parseInt(process.env.DISNEY7_SRT_PORT || '9001', 10),
    latencyMs: parseInt(process.env.DISNEY7_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.DISNEY7_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/disney7-buffer-16',
  },
  '18': {
    label: 'FUTV SRT',
    slug: 'FutvSrt',
    port: parseInt(process.env.FUTV_SRT_PORT || '9002', 10),
    latencyMs: parseInt(process.env.FUTV_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.FUTV_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/futv-srt-buffer-18',
  },
};
for (const cfg of Object.values(SRT_INGEST_CONFIGS)) {
  cfg.latencyUs = cfg.latencyMs * 1000;
  cfg.bufferPlaylist = path.join(cfg.bufferDir, 'buf.m3u8');
  cfg.minSegments = 3;
  cfg.waitTimeoutMs = 60000;
}
const isSrtIngestProcess = (process_id) => Object.prototype.hasOwnProperty.call(SRT_INGEST_CONFIGS, String(process_id));
const getSrtConfig = (process_id) => SRT_INGEST_CONFIGS[String(process_id)];

// ── Métricas SRT en vivo (para dashboard) ──
// Mapa<process_id, { connected, bitrateKbps, pktsLost, lastFrameAt, since }>
const tigoSrtMetrics = new Map();

const updateTigoSrtMetric = (process_id, patch) => {
  const key = String(process_id);
  const prev = tigoSrtMetrics.get(key) || {
    connected: false, bitrateKbps: 0, pktsLost: 0, lastFrameAt: 0, since: 0,
  };
  tigoSrtMetrics.set(key, { ...prev, ...patch });
};

const resetTigoSrtMetric = (process_id) => {
  tigoSrtMetrics.delete(String(process_id));
};

// Parser de stderr de FFmpeg para extraer bitrate y detectar frames.
// FFmpeg imprime líneas tipo: "frame=  150 fps= 30 q=23.0 size=    1234kB time=00:00:05.00 bitrate=2021.3kbits/s"
const parseFfmpegProgress = (line) => {
  const result = {};
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
  if (bitrateMatch) result.bitrateKbps = Math.round(parseFloat(bitrateMatch[1]));
  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) result.frame = parseInt(frameMatch[1], 10);
  return result;
};

// Map<process_id, ChildProcess> para FFmpeg #2 (output transcoder)
const tigoOutputProcesses = new Map();
// Map<process_id, intervalId> para watchdog que reinicia #2 si muere mientras #1 vive
const tigoOutputWatchdogs = new Map();

const cleanTigoBufferDir = () => {
  try {
    if (fs.existsSync(TIGO_BUFFER_DIR)) {
      for (const f of fs.readdirSync(TIGO_BUFFER_DIR)) {
        try { fs.unlinkSync(path.join(TIGO_BUFFER_DIR, f)); } catch (_) {}
      }
    } else {
      fs.mkdirSync(TIGO_BUFFER_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[tigo-buffer] cleanTigoBufferDir error:', err.message);
  }
};

// ── Helpers genéricos para SRT ingest (Tigo, Disney 7, FUTV SRT...) ──
const cleanSrtBufferDir = (cfg) => {
  try {
    if (fs.existsSync(cfg.bufferDir)) {
      for (const f of fs.readdirSync(cfg.bufferDir)) {
        try { fs.unlinkSync(path.join(cfg.bufferDir, f)); } catch (_) {}
      }
    } else {
      fs.mkdirSync(cfg.bufferDir, { recursive: true });
    }
  } catch (err) {
    console.error(`[srt-buffer:${cfg.label}] clean error:`, err.message);
  }
};

const waitForSrtBufferReady = async (cfg, timeoutMs) => {
  const limit = timeoutMs || cfg.waitTimeoutMs;
  const start = Date.now();
  while (Date.now() - start < limit) {
    try {
      if (fs.existsSync(cfg.bufferPlaylist)) {
        const segs = fs.readdirSync(cfg.bufferDir).filter(f => f.endsWith('.ts'));
        if (segs.length >= cfg.minSegments) {
          return { ready: true, segments: segs.length, waitedMs: Date.now() - start };
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return { ready: false, segments: 0, waitedMs: Date.now() - start };
};

// ETAPA 1 SRT genérico: FFmpeg SRT listener que recibe de OBS y escribe HLS buffer local.
const startSrtIngest = (process_id) => {
  const cfg = getSrtConfig(process_id);
  if (!cfg) throw new Error(`No SRT config for process_id=${process_id}`);
  // Blindaje: matar cualquier ffmpeg residual (huérfano) que esté usando este buffer
  // o esta carpeta de salida HLS, para evitar arrancar "encima" de un proceso zombi
  // que bloquearía el spawn de ETAPA 2 (caso real visto en Disney 7).
  try {
    const slug = HLS_SLUG_MAP[process_id] || `stream_${process_id}`;
    const patterns = [cfg.bufferDir, `live/${slug}/`, `:${cfg.port}?mode=listener`];
    for (const pat of patterns) {
      try { execSync(`pkill -9 -f ${JSON.stringify(pat)}`, { stdio: 'ignore' }); } catch (_) {}
    }
  } catch (_) {}
  cleanSrtBufferDir(cfg);
  resetTigoSrtMetric(process_id); // mapa de métricas SRT (genérico por process_id)

  let srtUrl = `srt://0.0.0.0:${cfg.port}?mode=listener&latency=${cfg.latencyUs}&pkt_size=1316`;
  if (cfg.passphrase && cfg.passphrase.length >= 10) {
    srtUrl += `&pbkeylen=16&passphrase=${encodeURIComponent(cfg.passphrase)}`;
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'verbose',
    '-stats',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-analyzeduration', '10000000',
    '-probesize', '5000000',
    '-i', srtUrl,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '10',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(cfg.bufferDir, 'buf_%05d.ts'),
    '-hls_allow_cache', '0',
    '-hls_start_number_source', 'epoch',
    cfg.bufferPlaylist,
  ];

  const proc = spawn('ffmpeg', args);
  updateTigoSrtMetric(process_id, { connected: false, since: Date.now() });
  return { process: proc, args, command: `ffmpeg ${args.join(' ')}`, cfg };
};

const waitForTigoBufferReady = async (timeoutMs = TIGO_BUFFER_WAIT_TIMEOUT_MS) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(TIGO_BUFFER_PLAYLIST)) {
        const segs = fs.readdirSync(TIGO_BUFFER_DIR).filter(f => f.endsWith('.ts'));
        if (segs.length >= TIGO_BUFFER_MIN_SEGMENTS) {
          return { ready: true, segments: segs.length, waitedMs: Date.now() - start };
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return { ready: false, segments: 0, waitedMs: Date.now() - start };
};

const stopTigoOutputStage = (process_id) => {
  const key = String(process_id);
  const wd = tigoOutputWatchdogs.get(key);
  if (wd) { clearInterval(wd); tigoOutputWatchdogs.delete(key); }
  const proc = tigoOutputProcesses.get(key);
  if (proc && !proc.killed) {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
  tigoOutputProcesses.delete(key);
};

// ── ETAPA 1 modo HDMI: FFmpeg SRT listener (Pi5 → VPS) ──────────────
// Map<process_id, ChildProcess> para el FFmpeg SRT listener (ETAPA 1 HDMI).
// NOTA: cuando se usa modo HDMI, este proceso REEMPLAZA al ffmpegProcess
// principal en `ffmpegProcesses`. Así toda la lógica de cierre/recovery existente
// (manejada en ffmpegProcess.on('close')) sigue funcionando idéntica.
const startTigoHdmiIngest = (process_id) => {
  cleanTigoBufferDir();
  resetTigoSrtMetric(process_id);

  // SRT listener: aceptamos cualquier streamid (el caller del Pi5 envía 'tigo-cr',
  // pero si hay mismatch FFmpeg rechaza el handshake en silencio). También
  // bajamos la latencia a la mínima recomendada (1000ms) para reducir el ventana
  // de buffering inicial — si el Pi5 estaba enviando con menos latencia, el
  // handshake fallaba.
  const srtUrl = `srt://0.0.0.0:${TIGO_SRT_PORT}?mode=listener&latency=${TIGO_SRT_LATENCY_US}&pkt_size=1316`;
  const args = [
    '-hide_banner',
    // verbose para ver mensajes SRT del handshake en stderr (sin esto, los
    // errores de "Connection rejected" son silenciosos hasta que muera FFmpeg).
    '-loglevel', 'verbose',
    '-stats',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    // Subido x3: el stream MPEG-TS del Pi5 tarda en exponer SPS/PPS,
    // hace falta más tiempo de análisis para no perder el video.
    '-analyzeduration', '10000000',
    '-probesize', '5000000',
    '-i', srtUrl,
    // CRÍTICO: mapear EXPLÍCITAMENTE video y audio. Sin esto FFmpeg
    // a veces descarta el video cuando llega como "unspecified size".
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    // NOTA: NO usar '-bsf:v h264_mp4toannexb' aquí — el stream MPEG-TS del Pi5
    // ya viene en Annex B, y aplicar el filtro causa fallo fatal silencioso.
    '-f', 'hls',
    '-hls_time', '10',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(TIGO_BUFFER_DIR, 'buf_%05d.ts'),
    '-hls_allow_cache', '0',
    '-hls_start_number_source', 'epoch',
    TIGO_BUFFER_PLAYLIST,
  ];

  const proc = spawn('ffmpeg', args);
  updateTigoSrtMetric(process_id, { connected: false, since: Date.now() });
  return { process: proc, args, command: `ffmpeg ${args.join(' ')}` };
};



const fetchWithOptionalProxy = (url, options = {}, useProxy = false) => {
  if (!useProxy) {
    return fetch(url, options);
  }

  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: getProxyAgent(),
      timeout: 15000,
    }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const setCookie = response.headers['set-cookie'];

        resolve({
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          status: response.statusCode || 0,
          headers: {
            get: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : (value ?? null);
            },
            getSetCookie: () => Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []),
          },
          text: async () => body,
          json: async () => {
            try {
              return JSON.parse(body || '{}');
            } catch (err) {
              throw new Error(`Respuesta JSON inválida del upstream: ${err.message}`);
            }
          },
        });
      });
    });

    const abortHandler = () => request.destroy(new Error('Request aborted'));
    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new Error('Request aborted'));
        return reject(new Error('Request aborted'));
      }
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    request.on('timeout', () => request.destroy(new Error('Request timeout')));
    request.on('error', reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
};

// Genera /tmp/proxychains-tigo.conf apuntando a TIGO_PROXY_URL.
// proxychains4 no entiende el esquema URL, así que parseamos host/puerto.
// Soporta socks5/socks5h (DNS remoto cuando es socks5h).
const ensureProxychainsConf = () => {
  try {
    const u = new URL(TIGO_PROXY_URL);
    const proto = u.protocol.replace(':', '').toLowerCase(); // socks5 / socks5h
    const remoteDns = proto === 'socks5h';
    const conf = [
      'strict_chain',
      remoteDns ? 'proxy_dns' : '# proxy_dns disabled (use socks5h to enable)',
      'tcp_read_time_out 15000',
      'tcp_connect_time_out 8000',
      '[ProxyList]',
      `socks5 ${u.hostname} ${u.port || 1080}${u.username ? ` ${u.username} ${u.password || ''}` : ''}`,
      '',
    ].join('\n');
    fs.writeFileSync(PROXYCHAINS_CONF_PATH, conf, 'utf8');
    return PROXYCHAINS_CONF_PATH;
  } catch (err) {
    console.error('[proxychains] Error escribiendo config:', err.message);
    return null;
  }
};

// Detecta si proxychains4 está instalado
let _proxychainsAvailable = null;
const isProxychainsAvailable = () => {
  if (_proxychainsAvailable !== null) return _proxychainsAvailable;
  try {
    execSync('which proxychains4', { stdio: 'ignore' });
    _proxychainsAvailable = true;
  } catch {
    _proxychainsAvailable = false;
  }
  return _proxychainsAvailable;
};

// ───────────────────────────────────────────────────────────────────────
// HEALTH-CHECK del proxy SOCKS5 (Pi5 CR) — usado para diagnóstico y
// pre-validación antes de spawn de FFmpeg para procesos con proxy.
// Hace una conexión TCP simple al puerto del proxy y mide latencia.
// NO consume tráfico (solo handshake TCP, ~50 bytes).
// ───────────────────────────────────────────────────────────────────────
const proxyHealthState = {
  lastCheck: 0,
  reachable: null,    // true | false | null (no probado)
  latencyMs: null,
  lastError: null,
  history: [],        // últimas 30 mediciones
};



const checkProxyHealth = (timeoutMs = 4000) => {
  return new Promise((resolve) => {
    let host, port;
    try {
      const u = new URL(TIGO_PROXY_URL);
      host = u.hostname;
      port = parseInt(u.port || '1080', 10);
    } catch {
      return resolve({ reachable: false, latencyMs: null, error: 'invalid proxy url' });
    }

    const start = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ reachable: false, latencyMs: null, error: `timeout ${timeoutMs}ms` }), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      finish({ reachable: true, latencyMs: Date.now() - start, error: null });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      finish({ reachable: false, latencyMs: null, error: err.code || err.message });
    });
  });
};

const updateProxyHealth = async () => {
  const result = await checkProxyHealth();
  proxyHealthState.lastCheck = Date.now();
  proxyHealthState.reachable = result.reachable;
  proxyHealthState.latencyMs = result.latencyMs;
  proxyHealthState.lastError = result.error;
  proxyHealthState.history.push({
    timestamp: proxyHealthState.lastCheck,
    reachable: result.reachable,
    latencyMs: result.latencyMs,
  });
  if (proxyHealthState.history.length > 30) proxyHealthState.history.shift();
  return result;
};

// Monitor pasivo: ping al proxy cada 60s, ~50 bytes/min (despreciable)
setInterval(() => {
  updateProxyHealth().catch(() => {});
}, 60_000);
// Primer check al arrancar (no bloqueante)
setTimeout(() => updateProxyHealth().catch(() => {}), 3_000);

// (DIRECT_URL_CHANNELS eliminado — sin uso actual)

// Procesos manuales/estables: recovery reutiliza la URL guardada en DB
const MANUAL_URL_PROCESSES = new Set(['0', '5', '10', '15']);

// Fuentes estables (watchdogs tolerantes + recovery lento) - canales con CDN fijo
const STABLE_SOURCE_PROCESSES = new Set(['0', '5', '10', '15']);
// Fuentes que usan -re (lectura a tasa nativa) — TODOS los canales lo necesitan
// Sin -re, FFmpeg lee a velocidad CPU (70-100fps), agota los segmentos HLS y causa EOF prematuro
const RE_FLAG_PROCESSES = new Set(['0', '1', '3', '4', '5', '6', '10', '11', '13', '14', '15']);
// Procesos con cadencia CFR (vsync cfr + 29.97fps) - canales de emisión EXCEPTO Disney 7 (TUDN)
// Disney 7 (ID 0) usa valores enteros (30fps/GOP60) porque el servidor RTMP destino
// rechaza conexiones con GOP decimal (59.94) causando Broken pipe a los ~120s
const CFR_OUTPUT_PROCESSES = new Set(['1', '3', '4', '5', '6', '10', '11', '13', '14', '15']);

// Fallback URLs oficiales por canal (se usan si el scraping falla)
const CHANNEL_FALLBACK_URLS = {
  '6': 'https://mdstrm.com/live-stream-playlist/5a7b1e63a8da282c34d65445.m3u8', // Multimedios oficial
  '15': 'https://d2qsan2ut81n2k.cloudfront.net/live/02f0dc35-8fd4-4021-8fa0-96c277f62653/ts:abr.m3u8', // Canal 6 oficial Repretel
};

// Track de intentos de recovery para saber cuándo usar fallback
const recoveryAttempts = new Map(); // Map<processId, number>


// Cache de sesión de scraping: guarda cookies + accessToken para pasarlos a FFmpeg
// Esto es CRÍTICO para Tigo cuyo CDN valida cookies/token junto con la IP
const scrapeSessionCache = new Map(); // Map<processId, { cookies, accessToken, timestamp }>

// Control de retry rápido para evitar loops cuando la misma URL vuelve a caer enseguida
const quickRetryState = new Map(); // Map<processId, lastQuickRetryTimestampMs>

// Última configuración útil conocida para no depender 100% de la base en un recovery
const lastKnownStreamState = new Map(); // Map<processId, { source_m3u8, target_rtmp, updatedAt }>

const rememberStreamState = (processId, streamState = {}) => {
  const key = String(processId);
  const previous = lastKnownStreamState.get(key) || {};
  const nextState = Object.fromEntries(
    Object.entries(streamState).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );

  lastKnownStreamState.set(key, {
    ...previous,
    ...nextState,
    updatedAt: Date.now(),
  });
};

const getRememberedStreamState = (processId) => lastKnownStreamState.get(String(processId)) || null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Watchdog: última vez que cada proceso produjo frames (timestamp ms)

// Watchdog: última vez que cada proceso produjo frames (timestamp ms)
const lastFrameTime = new Map(); // Map<processId, timestampMs>
const lastProgressLog = new Map(); // Map<processId, timestampMs> — throttle de logs de progreso
const PROGRESS_LOG_INTERVAL = 5000; // Loguear progreso cada 5 segundos
const WATCHDOG_STALL_TIMEOUT = 30000; // 30 segundos sin frames en running = proceso colgado
const WATCHDOG_START_TIMEOUT = 25000; // 25 segundos en starting sin primer frame = arranque colgado
const WATCHDOG_CHECK_INTERVAL = 10000; // Revisar cada 10 segundos
const SCRAPED_WATCHDOG_START_TIMEOUT = 45000; // TDMax puede tardar más en reenganchar tras jitter del CDN
const SCRAPED_WATCHDOG_STALL_TIMEOUT = 75000; // Dejar que FFmpeg agote más reintentos internos antes de matar
const RECOVERY_SCRAPE_ATTEMPTS = 3;
const RECOVERY_SCRAPE_BACKOFF_MS = 2500;
const AUTO_INGEST_PROCESSES = new Set();
const METRICS_TICK_INTERVAL = 1000;
const HLS_INPUT_RESILIENCE_ARGS = [
  '-rw_timeout', '5000000', // 5 segundos - reducido de 10s para fallar rápido y no causar stalls de 10s
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_at_eof', '1',
  '-reconnect_on_http_error', '5xx',
  '-reconnect_delay_max', '3', // 3s max entre reintentos (antes 5s) para recovery más ágil
];

// Watchdog interval: detecta procesos FFmpeg colgados, tanto en arranque como en ejecución
setInterval(() => {
  for (const [processId, processData] of ffmpegProcesses.entries()) {
    if (!processData.process || processData.process.killed) continue;
    
    const lastFrame = lastFrameTime.get(processId);
    const status = emissionStatuses.get(processId);
    const runtimeMs = Date.now() - (processData.startTime || Date.now());
    const isScrapedProcess = !!CHANNEL_MAP[String(processId)];

    // Caso 1: proceso pegado arrancando y nunca produjo el primer frame
    // Univision necesita hasta 90s porque su CDN es lento con IPs de datacenter
    const isUnivisionProcess = processData.source_m3u8 && (
      processData.source_m3u8.includes('univision') || 
      processData.source_m3u8.includes('tudn') || 
      processData.source_m3u8.includes('vix.com')
    );
    // En modo HDMI (Tigo): el flujo es Etapa 1 (SRT→HLS buffer) + espera ≥3 segs
    // (~30s) + Etapa 2 (transcoder que emite "frame="). 90s da margen para todo.
    const isTigoHdmiProcess = String(processId) === '12' && TIGO_USE_HDMI;
    const isSrtIngestProc = isSrtIngestProcess(processId);
    const startTimeout = isTigoHdmiProcess || isSrtIngestProc
      ? 120000 // 120s: OBS puede tardar en conectar (handshake SRT + buffer 30s + ETAPA 2)
      : isUnivisionProcess
      ? 90000  // 90s para Univision (CDN lento con datacenter IPs)
      : STABLE_SOURCE_PROCESSES.has(String(processId))
      ? 45000
      : isScrapedProcess
      ? SCRAPED_WATCHDOG_START_TIMEOUT
      : WATCHDOG_START_TIMEOUT;
    if (status === 'starting' && !lastFrame && runtimeMs > startTimeout) {
      const stalledSecs = Math.floor(runtimeMs / 1000);
      sendLog(processId, 'error', `🐕 WATCHDOG: Arranque colgado — ${stalledSecs}s sin primer frame. Forzando cierre para recovery...`);

      detectedErrors.set(processId, {
        type: 'source',
        reason: `Arranque colgado: ${stalledSecs}s sin primer frame (fuente/token/handshake bloqueado)`
      });

      if (supabase) {
        supabase
          .from('emission_processes')
          .update({
            failure_reason: 'stall',
            failure_details: `Watchdog de arranque: ${stalledSecs}s sin primer frame`,
            emit_status: 'error',
          })
          .eq('id', parseInt(processId))
          .then(() => {})
          .catch(err => console.error('Watchdog start DB error:', err));
      }

      try {
        processData.process.kill('SIGKILL');
      } catch (e) {
        console.error(`Watchdog start: error matando proceso ${processId}:`, e);
      }

      continue;
    }
    
    // Caso 2: proceso ya estaba corriendo y dejó de producir frames
    if (status !== 'running') continue;
    if (!lastFrame) continue;
    
    const stallTimeout = STABLE_SOURCE_PROCESSES.has(String(processId))
      ? 60000
      : PROXY_PROCESSES.has(String(processId))
      ? 120000  // Tigo via Pi5: aguantar reloads de token (60s) + jitter SOCKS5 sin matar
      : isScrapedProcess
      ? SCRAPED_WATCHDOG_STALL_TIMEOUT
      : WATCHDOG_STALL_TIMEOUT;
    const stalledMs = Date.now() - lastFrame;
    if (stalledMs > stallTimeout) {
      const stalledSecs = Math.floor(stalledMs / 1000);
      sendLog(processId, 'error', `🐕 WATCHDOG: Proceso colgado — ${stalledSecs}s sin producir frames. Forzando cierre para recovery...`);
      
      detectedErrors.set(processId, { 
        type: 'source', 
        reason: `Proceso colgado: ${stalledSecs}s sin frames (CDN/fuente dejó de responder)` 
      });
      
      if (supabase) {
        supabase
          .from('emission_processes')
          .update({
            failure_reason: 'stall',
            failure_details: `Watchdog: ${stalledSecs}s sin frames — CDN/fuente dejó de enviar datos`,
            emit_status: 'error',
          })
          .eq('id', parseInt(processId))
          .then(() => {})
          .catch(err => console.error('Watchdog DB error:', err));
      }
      
      try {
        processData.process.kill('SIGKILL');
      } catch (e) {
        console.error(`Watchdog: error matando proceso ${processId}:`, e);
      }
      
      lastFrameTime.delete(processId);
    }
  }
}, WATCHDOG_CHECK_INTERVAL);

setInterval(async () => {
  if (!supabase) return;

  const runningIds = [];
  const erroredIds = [];

  for (const [processId, processData] of ffmpegProcesses.entries()) {
    if (!processData.process || processData.process.killed) continue;

    const status = emissionStatuses.get(processId);
    if (status === 'running') {
      runningIds.push(Number(processId));
    } else if (status === 'error' || status === 'waiting_cdn') {
      erroredIds.push(Number(processId));
    }
  }

  try {
    await Promise.all([
      ...runningIds.map((processId) =>
        supabase.rpc('increment_active_time', { process_id: processId }).catch((err) => {
          console.error(`Error incrementando active_time para ${processId}:`, err.message);
        })
      ),
      ...erroredIds.map((processId) =>
        supabase.rpc('increment_down_time', { process_id: processId }).catch((err) => {
          console.error(`Error incrementando down_time para ${processId}:`, err.message);
        })
      ),
    ]);
  } catch (err) {
    console.error('Error en scheduler de métricas:', err.message);
  }
}, METRICS_TICK_INTERVAL);


// ==================== SCRAPING ON-DEMAND ====================
// Scraping simple: login → obtener URL → listo. Sin pool ni sesiones persistentes.
// Se usa un deviceId fijo por servidor para no crear sesiones fantasma en TDMax.
const FIXED_DEVICE_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const STREANN_RESELLER_ID = '61316705e4b0295f87dae396';
const STREANN_BASE_URL = 'https://cf.streann.tech';

// Scraping LOCAL (directo desde el VPS) — el token se genera con la IP del VPS
// así el CDN valida correctamente la IP que hace el request de video.
// Si useProxy=true, todo el tráfico (login + token) sale por el SOCKS5 del Pi 5
// para que el token quede vinculado a la IP residencial CR (caso Tigo).
const scrapeStreamUrlLocal = async (channelId, channelName, { useProxy = false } = {}) => {
  const tag = useProxy ? 'LOCAL via Pi5 (CR)' : 'LOCAL';
  sendLog('system', 'info', `🔄 Scraping ${tag} ${channelName}: obteniendo URL...`);
  
  const email = process.env.TDMAX_EMAIL;
  const password = process.env.TDMAX_PASSWORD;
  
  if (!email || !password) {
    return { url: null, error: 'Credenciales TDMAX no configuradas en el VPS (TDMAX_EMAIL / TDMAX_PASSWORD)' };
  }
  
  try {
    // Paso 1: Login — capturar cookies de la respuesta
    const loginResp = await fetchWithOptionalProxy(`${STREANN_BASE_URL}/web/services/v3/external/login?r=${STREANN_RESELLER_ID}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Origin': 'https://www.tdmax.com',
        'Referer': 'https://www.tdmax.com/',
      },
      body: JSON.stringify({
        username: email.toLowerCase(),
        password: password,
      }),
    }, useProxy);
    
    // Capturar todas las cookies del login
    const loginCookies = loginResp.headers.getSetCookie ? loginResp.headers.getSetCookie() : [];
    const loginCookieStr = loginCookies.map(c => c.split(';')[0]).join('; ');
    
    const loginData = await loginResp.json();
    
    if (loginData.errorMessage) {
      return { url: null, error: `Login error: ${loginData.errorMessage}` };
    }
    
    const accessToken = loginData.accessToken || loginData.access_token;
    if (!accessToken) {
      return { url: null, error: 'No se obtuvo token de acceso' };
    }
    
    sendLog('system', 'info', `✅ Login exitoso para ${channelName}${loginCookies.length > 0 ? ` (${loginCookies.length} cookies capturadas)` : ''}, obteniendo stream URL...`);
    
    // Paso 2: Obtener URL del stream — pasar cookies del login y capturar nuevas
    const lbUrl = `${STREANN_BASE_URL}/loadbalancer/services/v1/channels-secure/${channelId}/playlist.m3u8?r=${STREANN_RESELLER_ID}&deviceId=${FIXED_DEVICE_ID}&accessToken=${encodeURIComponent(accessToken)}&doNotUseRedirect=true&countryCode=CR&deviceType=web&appType=web`;
    
    const lbHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://www.tdmax.com',
      'Referer': 'https://www.tdmax.com/',
      'Authorization': `Bearer ${accessToken}`,
    };
    // Pasar cookies del login al loadbalancer
    if (loginCookieStr) {
      lbHeaders['Cookie'] = loginCookieStr;
    }
    
    const lbResp = await fetchWithOptionalProxy(lbUrl, {
      headers: lbHeaders,
      signal: AbortSignal.timeout(15000),
    }, useProxy);
    
    if (!lbResp.ok) {
      const errorText = await lbResp.text();
      return { url: null, error: `Error obteniendo stream: ${lbResp.status} - ${errorText.substring(0, 200)}` };
    }
    
    // Capturar cookies del loadbalancer también
    const lbCookies = lbResp.headers.getSetCookie ? lbResp.headers.getSetCookie() : [];
    const allCookieParts = [
      ...loginCookies.map(c => c.split(';')[0]),
      ...lbCookies.map(c => c.split(';')[0]),
    ];
    const allCookieStr = allCookieParts.join('; ');
    
    const lbData = await lbResp.json();
    const streamUrl = lbData.url;
    
    if (!streamUrl) {
      return { url: null, error: 'No se encontró URL de stream en la respuesta' };
    }
    
    const cookieCount = allCookieParts.filter(Boolean).length;
    sendLog('system', 'success', `✅ URL LOCAL obtenida para ${channelName}${cookieCount > 0 ? ` (${cookieCount} cookies para CDN)` : ''}`);
    
    // Retornar URL + accessToken + cookies para que FFmpeg los use
    return { url: streamUrl, accessToken, cookies: allCookieStr || null };
  } catch (err) {
    return { url: null, error: `Error en scraping local: ${err.message}` };
  }
};

// Scraping vía Edge Function (fallback si el local no está disponible)
const scrapeStreamUrlRemote = async (channelId, channelName) => {
  sendLog('system', 'info', `🔄 Scraping REMOTO ${channelName}: obteniendo URL via Edge Function...`);
  
  try {
    const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/scrape-channel`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ mode: 'full', channel_id: channelId }),
    });
    const data = await resp.json();
    
    if (data.success && data.url) {
      sendLog('system', 'success', `✅ URL REMOTA obtenida para ${channelName}`);
      return { url: data.url };
    }
    
    return { url: null, error: data.error || 'No se obtuvo URL' };
  } catch (err) {
    return { url: null, error: err.message };
  }
};

// Obtiene stream URL: primero intenta LOCAL (mismo IP), luego REMOTO (Edge Function)
const scrapeStreamUrl = async (channelId, channelName, opts = {}) => {
  // Intentar primero scraping local (para que el token se genere con la IP del VPS)
  const localResult = await scrapeStreamUrlLocal(channelId, channelName, opts);
  if (localResult.url) {
    return localResult;
  }
  
  sendLog('system', 'warn', `⚠️ Scraping local falló (${localResult.error}), intentando vía Edge Function...`);
  
  // Fallback: Edge Function (NOTA: la edge function NO usa proxy; si Tigo requiere proxy
  // estricto, este fallback puede fallar y será mejor que el local-via-proxy reintente)
  return await scrapeStreamUrlRemote(channelId, channelName);
};

const scrapeStreamUrlWithRetries = async (process_id, channelId, channelName) => {
  let lastError = 'No se obtuvo URL';
  const useProxy = PROXY_PROCESSES.has(String(process_id));

  for (let attempt = 1; attempt <= RECOVERY_SCRAPE_ATTEMPTS; attempt++) {
    try {
      const result = await scrapeStreamUrl(channelId, channelName, { useProxy });

      if (result?.url) {
        if (attempt > 1) {
          sendLog(process_id, 'success', `✅ Scraping recuperado en intento ${attempt}/${RECOVERY_SCRAPE_ATTEMPTS}`);
        }
        return result;
      }

      lastError = result?.error || lastError;
      sendLog(process_id, 'warn', `⚠️ Scraping intento ${attempt}/${RECOVERY_SCRAPE_ATTEMPTS} sin URL: ${lastError}`);
    } catch (error) {
      lastError = error?.message || String(error);
      sendLog(process_id, 'warn', `⚠️ Scraping intento ${attempt}/${RECOVERY_SCRAPE_ATTEMPTS} falló: ${lastError}`);
    }

    if (attempt < RECOVERY_SCRAPE_ATTEMPTS) {
      await sleep(RECOVERY_SCRAPE_BACKOFF_MS * attempt);
    }
  }

  return { url: null, error: lastError };
};
// ==================== FIN SCRAPING ====================







// Espera a que el proceso FFmpeg esté completamente muerto (con timeout agresivo)
const waitForProcessDeath = (proc, timeoutMs = 1500) => {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return resolve();
    }

    let resolved = false;
    let sigkillSent = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollTimer);
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };

    const pollTimer = setInterval(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) return finish();
      if (proc.pid && typeof isPidAlive === 'function' && !isPidAlive(proc.pid)) return finish();
    }, 100);

    const killTimer = setTimeout(() => {
      if (!resolved && !sigkillSent) {
        sigkillSent = true;
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
    }, timeoutMs);

    const giveUpTimer = setTimeout(finish, timeoutMs + 1500);
    proc.once('close', finish);
  });
};

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleepForPidKill = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const killPidIfAlive = async (pid) => {
  if (!isPidAlive(pid)) return false;

  try { process.kill(pid, 'SIGTERM'); } catch {}

  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    await sleepForPidKill(150);
    if (!isPidAlive(pid)) return true;
  }

  try { process.kill(pid, 'SIGKILL'); } catch {}

  const hardKillStartedAt = Date.now();
  while (Date.now() - hardKillStartedAt < 2000) {
    await sleepForPidKill(150);
    if (!isPidAlive(pid)) return true;
  }

  try {
    execSync(`kill -9 ${pid}`, { timeout: 2000 });
  } catch {}

  return !isPidAlive(pid);
};

const autoRecoverChannel = async (process_id, channelId, channelName = 'Canal') => {
  // Verificar si hubo parada manual mientras se esperaba
  if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
    sendLog(process_id, 'info', `🛑 AUTO-RECOVERY cancelado: parada manual detectada para ${channelName}`);
    manualStopProcesses.delete(String(process_id));
    manualStopProcesses.delete(Number(process_id));
    return;
  }
  
  if (autoRecoveryInProgress.get(process_id)) {
    sendLog(process_id, 'warn', '⏳ Auto-recovery ya en progreso, ignorando...');
    return;
  }
  
  autoRecoveryInProgress.set(process_id, true);
  const attempts = (recoveryAttempts.get(process_id) || 0) + 1;
  recoveryAttempts.set(process_id, attempts);
  
  let newUrl = null;
  const fallbackUrl = CHANNEL_FALLBACK_URLS[process_id];
  const rememberedState = getRememberedStreamState(process_id);
  
  // Si es el segundo intento (o más) y hay fallback, usar directamente la URL oficial
  if (attempts >= 2 && fallbackUrl) {
    sendLog(process_id, 'warn', `🔄 AUTO-RECOVERY ${channelName} (intento #${attempts}): Usando URL oficial de respaldo...`);
    newUrl = fallbackUrl;
  } else {
    sendLog(process_id, 'info', `🔄 AUTO-RECOVERY ${channelName} (intento #${attempts}): Obteniendo nueva URL...`);
    
    // 🧹 FIX: Si llevamos 2+ intentos seguidos, la sesión cacheada (cookies/token previos)
    // está envenenada. Invalidarla fuerza al scraper a hacer un login limpio en TDMax,
    // que es lo que típicamente recupera el canal cuando el CDN devuelve 404 con tokens
    // recién generados (ventana de mantenimiento nocturno, sesión backend muerta, etc.).
    if (attempts >= 2) {
      const hadCache = scrapeSessionCache.has(String(process_id)) || scrapeSessionCache.has(process_id);
      scrapeSessionCache.delete(String(process_id));
      scrapeSessionCache.delete(process_id);
      if (hadCache) {
        sendLog(process_id, 'warn', `🧹 Sesión TDMax invalidada tras ${attempts - 1} fallo(s) consecutivo(s) - forzando login limpio`);
      }
      // Pequeña pausa para dejar respirar al backend de TDMax/CDN antes del re-login
      await new Promise(r => setTimeout(r, 1500));
    }
    
    try {
      const result = await scrapeStreamUrlWithRetries(process_id, channelId, channelName);
      
      if (result.url) {
        newUrl = result.url;
        // Cachear sesión para FFmpeg (cookies + token)
        if (result.cookies || result.accessToken) {
          scrapeSessionCache.set(String(process_id), {
            cookies: result.cookies || null,
            accessToken: result.accessToken || null,
            timestamp: Date.now(),
          });
          sendLog(process_id, 'info', `🔐 Sesión de recovery cacheada (cookies: ${result.cookies ? 'sí' : 'no'})`);
        }
        sendLog(process_id, 'success', `✅ URL obtenida para ${channelName}`);
      } else if (fallbackUrl) {
        sendLog(process_id, 'warn', `⚠️ Scraping falló (${result.error || 'sin URL'}), usando URL oficial de respaldo para ${channelName}`);
        newUrl = fallbackUrl;
      } else {
        sendLog(process_id, 'error', `❌ AUTO-RECOVERY falló: ${result.error || 'No se obtuvo URL'}`);
        autoRecoveryInProgress.set(process_id, false);
        return;
      }
    } catch (scrapeError) {
      if (fallbackUrl) {
        sendLog(process_id, 'warn', `⚠️ Error en scraping (${scrapeError.message}), usando URL oficial de respaldo`);
        newUrl = fallbackUrl;
      } else {
        sendLog(process_id, 'error', `❌ AUTO-RECOVERY error: ${scrapeError.message}`);
        autoRecoveryInProgress.set(process_id, false);
        return;
      }
    }
  }
  
  try {
    const newUrl_display = newUrl === fallbackUrl ? '🏛️ URL OFICIAL' : newUrl.substring(0, 80) + '...';
    sendLog(process_id, 'success', `✅ Nueva URL ${channelName}: ${newUrl_display}`);
    
    // CRÍTICO: Asegurarse de que el proceso anterior esté COMPLETAMENTE muerto antes de reiniciar
    const existingProc = ffmpegProcesses.get(process_id);
    if (existingProc && existingProc.process && !existingProc.process.killed) {
      sendLog(process_id, 'info', '🔪 Terminando proceso anterior antes de reiniciar...');
      existingProc.process.kill('SIGKILL'); // SIGKILL directo para máxima velocidad
      await waitForProcessDeath(existingProc.process, 1500);
      ffmpegProcesses.delete(process_id);
      sendLog(process_id, 'info', '✔ Proceso anterior terminado correctamente');
    }
    
    let targetRtmp = '';
    if (rememberedState?.target_rtmp) {
      targetRtmp = rememberedState.target_rtmp;
    }

    if (supabase) {
      const { data: row } = await supabase
        .from('emission_processes')
        .select('rtmp')
        .eq('id', parseInt(process_id))
        .single();
      if (row?.rtmp) targetRtmp = row.rtmp;
    }
    
    // HLS output processes don't need RTMP target
    if (!targetRtmp && !HLS_OUTPUT_PROCESSES.has(String(process_id))) {
      sendLog(process_id, 'error', `❌ AUTO-RECOVERY: No se encontró RTMP destino para proceso ${process_id}`);
      autoRecoveryInProgress.set(process_id, false);
      return;
    }

    rememberStreamState(process_id, { source_m3u8: newUrl, target_rtmp: targetRtmp });
    
    if (supabase) {
      await supabase
        .from('emission_processes')
        .update({ m3u8: newUrl, emit_status: 'starting', is_emitting: true, is_active: true })
        .eq('id', parseInt(process_id));
    }
    
    sendLog(process_id, 'info', '🚀 AUTO-RECOVERY: Reiniciando emisión con nueva URL...');
    
    const emitUrl = `http://localhost:${PORT}/api/emit`;
    const emitResp = await fetch(emitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_m3u8: newUrl,
        target_rtmp: targetRtmp || 'hls-local',
        process_id: process_id,
        is_recovery: true
      })
    });
    
    if (!emitResp.ok) {
      const errText = await emitResp.text().catch(() => '');
      sendLog(process_id, 'error', `❌ AUTO-RECOVERY: El endpoint /api/emit respondió ${emitResp.status}: ${errText.substring(0, 100)}`);
    } else {
      sendLog(process_id, 'success', '✅ AUTO-RECOVERY completado: Emisión reiniciada correctamente');
      // Incrementar contador de recovery en la base de datos
      if (supabase) {
        try {
          const { error: rpcErr } = await supabase.rpc('increment_recovery_count', { process_id: parseInt(process_id) });
          if (rpcErr) {
            // Fallback: leer valor actual y sumar 1 si la función RPC falla
            const { data: currentRow } = await supabase
              .from('emission_processes')
              .select('recovery_count')
              .eq('id', parseInt(process_id))
              .single();
            const currentCount = currentRow?.recovery_count || 0;
            await supabase
              .from('emission_processes')
              .update({ recovery_count: currentCount + 1 })
              .eq('id', parseInt(process_id));
          }
        } catch (fallbackErr) {
          console.error('Error incrementando recovery_count:', fallbackErr.message);
        }
      }
      // Si fue exitoso con URL oficial, resetear intentos
      if (newUrl === fallbackUrl) {
        recoveryAttempts.set(process_id, 0);
      }
    }
  } catch (error) {
    sendLog(process_id, 'error', `❌ AUTO-RECOVERY error: ${error.message}`);
  } finally {
    autoRecoveryInProgress.set(process_id, false);
  }
};

// Función para verificar si un destino RTMP ya está en uso
const checkRTMPConflict = (target_rtmp, current_process_id) => {
  for (const [processId, processData] of ffmpegProcesses.entries()) {
    if (processId !== current_process_id && 
        processData.target_rtmp === target_rtmp && 
        processData.process && 
        !processData.process.killed) {
      return processId;
    }
  }
  return null;
};

// Función mejorada para detectar y categorizar problemas
const detectAndCategorizeError = (output, processId) => {
  const isEOF = output.includes('End of file') || output.includes('error=End of file');
  const isReconnectEOF = isEOF && output.includes('Will reconnect at');
  const proc = ffmpegProcesses.get(processId);
  const elapsed = proc ? (Date.now() - proc.startTime) / 1000 : 999;

  // Mensaje transitorio de FFmpeg durante reconexión automática: no tratar como error.
  if (isReconnectEOF) {
    return true;
  }

  // Detectar errores de fuente M3U8
  // Para procesos manuales (0, 5, 10) con reconnect 4xx habilitado,
  // los 404 transitorios son manejados internamente por FFmpeg — no tratar como fatal
  const isManualProcess = MANUAL_URL_PROCESSES.has(String(processId));
  
  if (output.includes('Invalid data found') || 
      output.includes('Server returned 404') ||
      output.includes('Server returned 403') ||
      output.includes('HTTP error 403') ||
      output.includes('Server returned 5') ||
      output.includes('End of file') ||
      output.includes('error=End of file') ||
      (output.includes('Connection refused') && output.includes('http'))) {
    
    // Filtrar errores de "End of file" durante los primeros 10 segundos (son normales al arrancar HLS multi-variante)
    if (isEOF && elapsed < 10) {
      return true; // Ignorar silenciosamente, no es un error real
    }

    // Para procesos manuales: 403, 404 y EOF transitorios suelen venir del CDN.
    // Los tratamos como advertencia operativa, pero sí dejamos la causa registrada
    // por si FFmpeg termina cerrando el proceso después de agotar sus reintentos internos.
    if (isManualProcess && (
      output.includes('Server returned 404') || 
      output.includes('Server returned 403') || 
      output.includes('HTTP error 403') || 
      (isEOF && elapsed > 10)
    )) {
      const reason = output.includes('403')
        ? '403 transitorio del CDN (FFmpeg reintentará internamente con reconnect 4xx)'
        : output.includes('404')
        ? '404 transitorio del CDN (FFmpeg reintentará internamente)'
        : 'EOF transitorio del CDN (FFmpeg reintentará internamente)';
      sendLog(processId, 'warn', `⚠️ CDN: ${reason}`);
      detectedErrors.set(processId, { type: 'source', reason });
      return true; // No marcar como error fatal inmediato
    }

    const reason = output.includes('404') ? 'URL Fuente M3U8 no encontrada (404)' :
                   output.includes('403') ? 'Sesión expirada o token inválido (403 Forbidden)' :
                   output.includes('End of file') ? 'Fuente M3U8 agotada o CDN cortó conexión (EOF)' :
                   output.includes('Invalid data') ? 'URL Fuente M3U8 inválida o corrupta' :
                   output.includes('Connection refused') ? 'CDN rechazó conexión (Connection refused)' :
                   'URL Fuente M3U8 no accesible';
    sendLog(processId, 'error', `ERROR DE FUENTE: ${reason}`);
    sendFailureNotification(processId, 'source', reason);
    // Guardar error detectado para usarlo cuando FFmpeg cierre
    detectedErrors.set(processId, { type: 'source', reason });
    
    // No matamos el proceso aquí para evitar carreras con reinicios nuevos.
    // Dejamos que FFmpeg cierre naturalmente y el handler "close" dispare el recovery.

    return true;
  }
  
  // Detectar errores de destino RTMP (incluyendo Broken pipe)
  if (output.includes('Connection to tcp://') && output.includes('failed') ||
      output.includes('RTMP handshake failed') ||
      output.includes('rtmp://') && output.includes('failed') ||
      output.includes('Server rejected') ||
      output.includes('Connection reset by peer') ||
      output.includes('Broken pipe') ||
      output.includes('Unable to publish')) {
    const reason = output.includes('Broken pipe') ? 'Servidor RTMP cerró la conexión (Broken pipe)' :
                   output.includes('Connection to tcp://') && output.includes('failed') ? 'Destino RTMP no responde o URL incorrecta' :
                   output.includes('RTMP handshake failed') ? 'Fallo en handshake RTMP (verificar URL)' :
                   output.includes('Server rejected') ? 'Servidor RTMP rechazó la conexión' :
                   output.includes('Connection reset') ? 'Conexión RTMP resetteada por el servidor' :
                   'No se pudo publicar al destino RTMP';
    sendLog(processId, 'error', `ERROR DE RTMP: ${reason}`);
    sendFailureNotification(processId, 'rtmp', reason);
    detectedErrors.set(processId, { type: 'rtmp', reason });
    return true;
  }
  
  // Detectar errores del servidor/FFmpeg
  if (output.includes('Cannot allocate memory') ||
      output.includes('Killed') ||
      output.includes('Segmentation fault') ||
      output.includes('out of memory')) {
    const reason = output.includes('memory') ? 'Servidor sin memoria suficiente' :
                   output.includes('Killed') ? 'Proceso FFmpeg terminado por el sistema' :
                   'Fallo crítico del servidor';
    sendLog(processId, 'error', `ERROR DEL SERVIDOR: ${reason}`);
    sendFailureNotification(processId, 'server', reason);
    detectedErrors.set(processId, { type: 'server', reason });
    return true;
  }
  
  return false;
};

// Función para resolver variante de un master HLS playlist
// targetBandwidth: si se pasa (en bps), selecciona la variante más cercana sin exceder ese target.
//                  Si no se pasa o es 0, selecciona la de mayor BANDWIDTH.
const resolveBestHLSVariant = async (masterUrl, options = {}) => {
  const {
    targetBandwidth = 0,
    headers = {},
    cookies = null,
  } = options;

  try {
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...headers,
    };

    if (cookies) {
      requestHeaders.Cookie = cookies;
    }

    const resp = await fetch(masterUrl, { headers: requestHeaders });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const body = await resp.text();

    // Si no es un master playlist (no tiene #EXT-X-STREAM-INF), devolver la URL original
    if (!body.includes('#EXT-X-STREAM-INF')) {
      return { resolvedUrl: masterUrl, bandwidth: 0, resolution: 'direct', allVariants: [] };
    }

    // Parsear todas las variantes
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
        const resMatch = lines[i].match(/RESOLUTION=([\dx]+)/);
        const resolution = resMatch ? resMatch[1] : null;
        const variantUrl = lines[i + 1];

        if (variantUrl && !variantUrl.startsWith('#')) {
          variants.push({ bandwidth, resolution, url: variantUrl, programIndex: variants.length });
        }
      }
    }

    if (variants.length === 0) {
      return { resolvedUrl: masterUrl, bandwidth: 0, resolution: 'unknown', allVariants: [] };
    }

    // Ordenar por bandwidth ascendente
    variants.sort((a, b) => a.bandwidth - b.bandwidth);

    let selected;
    if (targetBandwidth > 0) {
      // Seleccionar la variante más alta que no exceda el target
      // Si ninguna cabe, tomar la más baja disponible
      const fitting = variants.filter(v => v.bandwidth <= targetBandwidth);
      selected = fitting.length > 0 ? fitting[fitting.length - 1] : variants[0];
    } else {
      // Sin target: tomar la más alta
      selected = variants[variants.length - 1];
    }

    let bestUrl = selected.url;

    // Resolver URL relativa
    if (!bestUrl.startsWith('http')) {
      const base = new URL(masterUrl);
      bestUrl = new URL(bestUrl, base).toString();
    }

    const resolution = selected.resolution || `${Math.round(selected.bandwidth / 1000)}kbps`;

    // Log de todas las variantes disponibles para diagnóstico
    const variantList = variants.map(v => `${v.resolution || '?'} @ ${Math.round(v.bandwidth / 1000)}kbps`).join(' | ');
    console.log(`HLS variants: [${variantList}] → Selected: ${resolution} @ ${Math.round(selected.bandwidth / 1000)}kbps (target: ${targetBandwidth > 0 ? Math.round(targetBandwidth / 1000) + 'kbps' : 'MAX'})`);

    return { resolvedUrl: bestUrl, bandwidth: selected.bandwidth, resolution, allVariants: variants };
  } catch (err) {
    console.error('Error parsing HLS master playlist:', err.message);
    return { resolvedUrl: masterUrl, bandwidth: 0, resolution: 'fallback', allVariants: [] };
  }
};

// Función auxiliar para detectar resolución y bitrate de cualquier fuente (M3U8 o archivo)
const detectSourceInfo = async (source) => {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,bit_rate',
      '-show_entries', 'format=bit_rate',
      '-of', 'json',
      source
    ]);
    
    let output = '';
    probe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    probe.on('close', () => {
      try {
        const data = JSON.parse(output);
        const width = data.streams?.[0]?.width || 0;
        const height = data.streams?.[0]?.height || 0;
        // Bitrate: intentar stream, luego format (en bps, convertir a kbps)
        const streamBitrate = parseInt(data.streams?.[0]?.bit_rate || '0');
        const formatBitrate = parseInt(data.format?.bit_rate || '0');
        const bitrateKbps = Math.round((streamBitrate || formatBitrate) / 1000);
        resolve({ width, height, bitrateKbps });
      } catch (e) {
        resolve({ width: 0, height: 0, bitrateKbps: 0 });
      }
    });
    
    probe.on('error', () => {
      resolve({ width: 0, height: 0, bitrateKbps: 0 });
    });
  });
};

// Endpoint para scraping LOCAL desde el VPS (para que el token se genere con la IP del VPS)
// Esto es CRÍTICO para canales como Tigo cuyo CDN valida IP del token vs IP del consumidor
app.post('/api/local-scrape', async (req, res) => {
  try {
    const { channel_id, process_id, player_url } = req.body;
    
    if (!channel_id) {
      return res.status(400).json({ success: false, error: 'Falta channel_id' });
    }
    
    const channelName = CHANNEL_MAP[process_id]?.channelName || `Canal ${channel_id.substring(0, 8)}`;
    const useProxy = PROXY_PROCESSES.has(String(process_id));
    const result = await scrapeStreamUrlLocal(channel_id, channelName, { useProxy });
    
    if (!result.url) {
      return res.json({ success: false, error: result.error || 'No se obtuvo URL' });
    }
    
    // Guardar sesión en cache para que /api/emit la use con FFmpeg
    if (process_id !== undefined) {
      scrapeSessionCache.set(String(process_id), {
        cookies: result.cookies || null,
        accessToken: result.accessToken || null,
        timestamp: Date.now(),
      });
      sendLog(String(process_id), 'info', `🔐 Sesión de scraping guardada en cache (cookies: ${result.cookies ? 'sí' : 'no'}, token: ${result.accessToken ? 'sí' : 'no'})`);
    }

    // FUTV ALTERNO (17): persistir player_url para sobrevivir reinicios
    if (String(process_id) === '17' && player_url && supabase) {
      try {
        await supabase
          .from('emission_processes')
          .update({ player_url: String(player_url) })
          .eq('id', 17);
        sendLog('17', 'info', `💾 player_url guardado para auto-recovery tras reinicio`);
      } catch (e) {
        sendLog('17', 'warn', `⚠️ No se pudo guardar player_url: ${e.message}`);
      }
    }

    return res.json({ success: true, url: result.url, channel: channelName });
  } catch (error) {
    console.error('Error en /api/local-scrape:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para iniciar emisión
app.post('/api/emit', async (req, res) => {
  try {
    const { source_m3u8, target_rtmp, process_id: rawProcessId = '0', is_recovery = false } = req.body;
    const process_id = String(rawProcessId);
    const numericId = parseInt(process_id, 10);
    let effectiveSourceM3u8 = source_m3u8;
    const isHlsOutput = HLS_OUTPUT_PROCESSES.has(process_id);
    const isTigoHdmiProcess = process_id === '12' && TIGO_USE_HDMI;
    // SRT ingest: si el caller no provee source_m3u8 (o lo marca como srt://obs),
    // arrancamos un listener SRT que recibe de OBS en el puerto del proceso.
    const isSrtIngest = isSrtIngestProcess(process_id) && (
      !source_m3u8 ||
      String(source_m3u8).startsWith('srt://obs') ||
      String(source_m3u8).startsWith('srt://0.0.0.0')
    );
    // Procesos manuales OBS = todos los SRT ingest (12, 16, 18).
    const isManualObsIngest = isSrtIngestProcess(process_id);

    if (isTigoHdmiProcess && !effectiveSourceM3u8) {
      effectiveSourceM3u8 = `srt://pi5-hdmi:${TIGO_SRT_PORT}`;
    }
    if (isSrtIngest && !effectiveSourceM3u8) {
      const cfg = getSrtConfig(process_id);
      effectiveSourceM3u8 = `srt://obs:${cfg.port}`;
    }

    // Validación de ID: debe ser un número entre 0 y 18
    if (isNaN(numericId) || numericId < 0 || numericId > 18) {
      sendLog(process_id, 'error', `❌ ID de proceso inválido: "${rawProcessId}" (debe ser 0-18)`);
      return res.status(400).json({ error: `ID de proceso inválido: debe ser un número entre 0 y 18` });
    }

    // Resetear contador y limpiar flags de parada manual SOLO cuando es inicio manual
    if (!is_recovery) {
      recoveryAttempts.set(process_id, 0);
      manualStopProcesses.delete(process_id);
      manualStopProcesses.delete(numericId);
      nightRestStoppedProcesses.delete(process_id);
      resetCircuitBreaker(process_id);
    }
    
    sendLog(process_id, 'info', `Nueva solicitud de emisión recibida`, { source_m3u8, target_rtmp });

    // Validaciones
    if ((!isTigoHdmiProcess && !isSrtIngest && !effectiveSourceM3u8) || (!target_rtmp && !isHlsOutput)) {
      sendLog(process_id, 'error', 'Faltan parámetros requeridos: source_m3u8 y target_rtmp');
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
      });
    }

    // (Antes había fallback RTMP para Tigo cuando no era ingest SRT — eliminado:
    //  todos los procesos manuales OBS ahora usan SRT exclusivamente.)

    // ── Refresco de token JIT para procesos con proxy (Tigo: wmsAuthSign dura 60s) ──
    // El token de Teletica/Tigo expira en 1 minuto, así que re-scrapeamos vía Pi5
    // justo antes de spawn de FFmpeg para garantizar token fresco.
    // OPTIMIZACIÓN #1: si el caller (Quick Retry) ya scrapeó hace <10s, reusar la
    // URL recibida y saltar este refresh para evitar doble scrape (que duplica
    // sesiones en Streann y desincroniza el token con la conexión FFmpeg).
    if (!isTigoHdmiProcess && PROXY_PROCESSES.has(process_id) && CHANNEL_MAP[process_id]) {
      const cached = scrapeSessionCache.get(process_id);
      const cacheAgeMs = cached?.timestamp ? Date.now() - cached.timestamp : Infinity;
      const skipRefresh = is_recovery && cacheAgeMs < 10000;

      if (skipRefresh) {
        sendLog(process_id, 'info', `♻️ Reusando URL fresca del Quick Retry (scrapeada hace ${Math.round(cacheAgeMs / 1000)}s) — sin doble scrape`);
      } else {
        const { channelId, channelName } = CHANNEL_MAP[process_id];
        sendLog(process_id, 'info', `🔄 Refrescando URL via Pi5 (token de 60s)...`);
        const fresh = await scrapeStreamUrlLocal(channelId, channelName, { useProxy: true });
        if (fresh.url) {
          effectiveSourceM3u8 = fresh.url;
          scrapeSessionCache.set(process_id, {
            cookies: fresh.cookies || null,
            accessToken: fresh.accessToken || null,
            timestamp: Date.now(),
          });
          sendLog(process_id, 'success', `✅ URL fresca obtenida via Pi5 para ${channelName}`);
        } else {
          sendLog(process_id, 'error', `❌ No se pudo refrescar URL via Pi5: ${fresh.error || 'desconocido'}`);
          return res.status(502).json({ error: `Refresco de URL falló: ${fresh.error || 'sin URL'}` });
        }
      }
    }

    rememberStreamState(process_id, { source_m3u8: effectiveSourceM3u8, target_rtmp });

    // (Tigo processes removed — dead code cleaned up)

    // VALIDACIÓN CRÍTICA: Verificar conflicto de destino RTMP (skip para HLS output)
    const conflictingProcessId = isHlsOutput ? null : checkRTMPConflict(target_rtmp, process_id);
    if (conflictingProcessId) {
      const conflictingProcess = ffmpegProcesses.get(conflictingProcessId);
      sendLog(process_id, 'error', `⚠️ CONFLICTO: El destino RTMP ya está en uso por Proceso ${conflictingProcessId}`);
      sendLog(conflictingProcessId, 'warn', `⚠️ Otro proceso (${process_id}) intenta usar el mismo destino RTMP - deteniendo este proceso`);
      
      // Detener el proceso conflictivo
      if (conflictingProcess && conflictingProcess.process && !conflictingProcess.process.killed) {
        manualStopProcesses.add(String(conflictingProcessId));
        manualStopProcesses.add(Number(conflictingProcessId));
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // VALIDACIÓN: Bloqueo mutuo de slug HLS (FUTV vs FUTV ALTERNO comparten 'FUTV').
    // Si otro proceso ya está emitiendo al mismo slug, rechazamos para no pisar la señal.
    if (isHlsOutput) {
      const mySlug = HLS_SLUG_MAP[process_id];
      if (mySlug) {
        for (const [otherPid, otherSlug] of Object.entries(HLS_SLUG_MAP)) {
          if (otherPid === process_id) continue;
          if (otherSlug !== mySlug) continue;
          const otherProc = ffmpegProcesses.get(otherPid);
          if (otherProc && otherProc.process && !otherProc.process.killed) {
            const otherLabel = CHANNEL_CONFIGS_SERVER[otherPid] || `Proceso ${otherPid}`;
            const myLabel = CHANNEL_CONFIGS_SERVER[process_id] || `Proceso ${process_id}`;
            sendLog(process_id, 'error', `🚫 BLOQUEO: ${myLabel} no puede arrancar porque ${otherLabel} ya emite al slug "${mySlug}". Detén ${otherLabel} primero.`);
            // Revertir is_emitting si quedó en true por el upsert previo (no llegamos a hacerlo aún, pero por seguridad)
            return res.status(409).json({
              error: `Conflicto de salida HLS: ${otherLabel} (ID ${otherPid}) ya emite al slug "${mySlug}". Detenlo antes de iniciar ${myLabel}.`
            });
          }
        }
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      // Marcar como manual temporalmente para que el close handler del VIEJO proceso no dispare recovery
      manualStopProcesses.add(String(process_id));
      manualStopProcesses.add(Number(process_id));
      existingProcess.process.kill('SIGTERM');
      await waitForProcessDeath(existingProcess.process, 2000);
      ffmpegProcesses.delete(process_id);
      // CRÍTICO: Limpiar flag de parada manual DESPUÉS de que el viejo proceso murió
      // para que el NUEVO proceso pueda hacer recovery si se cae
      manualStopProcesses.delete(String(process_id));
      manualStopProcesses.delete(Number(process_id));
      
      // Actualizar el registro anterior como finalizado (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({ 
            is_active: false, 
            is_emitting: false, 
            ended_at: new Date().toISOString(),
            emit_status: 'stopped',
            start_time: 0,
            elapsed: 0,
            ffmpeg_pid: null,
          })
          .eq('id', parseInt(process_id))
          .eq('ffmpeg_pid', existingProcess.process.pid)
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos (solo si Supabase está disponible)
    let dbRecord = null;
    if (supabase) {
      // Resetear recovery_count y failure state en inicio manual
      const upsertData = {
        id: parseInt(process_id),
        m3u8: effectiveSourceM3u8,
        rtmp: isHlsOutput ? 'hls-local' : target_rtmp,
        source_url: effectiveSourceM3u8,
        is_active: true,
        is_emitting: true,
        emit_status: 'starting',
        start_time: Math.floor(Date.now() / 1000),
        process_logs: `[${new Date().toISOString()}] Iniciando emisión desde M3U8\n`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        failure_reason: null,
        failure_details: null,
      };
      // Solo resetear contadores en inicio manual (no en recovery)
      if (!is_recovery) {
        upsertData.recovery_count = 0;
        upsertData.last_signal_duration = 0;
      }
      const { data, error: dbError } = await supabase
        .from('emission_processes')
        .update(upsertData)
        .eq('id', parseInt(process_id))
        .select()
        .single();

      dbRecord = data || null;

      if (dbError) {
        sendLog(process_id, 'warn', `Error guardando en DB: ${dbError.message}`);
      } else {
        sendLog(process_id, 'info', `✅ Proceso guardado en base de datos (ID: ${process_id})`);
      }
    } else {
      sendLog(process_id, 'warn', 'Supabase no configurado: no se guardará el proceso en base de datos.');
    }
    
    let ffmpegArgs;
    
    // Si es recovery, damos un poco menos de análisis para reenganchar rápido,
    // pero suficiente para evitar fallos por parámetros incompletos de streams HLS.
    // Fuentes estables (Canal 6) siempre usan valores altos para enganchar limpiamente.
    const isRecovery = Boolean(is_recovery);
    const isStableSource = STABLE_SOURCE_PROCESSES.has(String(process_id));
    // Univision tiene 5 programas + subtítulos EIA-608 = manifiesto pesado, necesita más análisis
    const analyzeDuration = isStableSource ? '3000000' : (isRecovery ? '1500000' : '3000000');
    const probeSize      = isStableSource ? '2000000' : (isRecovery ? '500000'  : '1500000');

    // Detectar cabeceras HTTP según dominio fuente y canal para mayor compatibilidad
    // Nota: para procesos OBS-ingest (SRT) el spawn real ocurre en `startSrtIngest`,
    // así que estas variables solo aplican a flujos HLS/RTMP convencionales.
    const isRtmpInputSource = isManualObsIngest; // (legacy alias, kept for branch below)
    const isManualProcess = MANUAL_URL_PROCESSES.has(String(process_id)) && !isRtmpInputSource;
    let refererDomain = 'https://www.tdmax.com/';
    let originDomain = 'https://www.tdmax.com';
    let isUnivisionLikeSource = false;
    let isMediatiqueSource = false;
    let isAkamaiSource = false;
    try {
      const sourceUrl = new URL(effectiveSourceM3u8);
      const hostname = sourceUrl.hostname.toLowerCase();

      if (hostname.includes('teletica.com')) {
        refererDomain = 'https://www.teletica.com/';
        originDomain = 'https://www.teletica.com';
      } else if (hostname.includes('cloudfront.net') || hostname.includes('repretel.com') || hostname.includes('mediatiquestream.com')) {
        isMediatiqueSource = true;
        refererDomain = 'https://www.repretel.com/';
        originDomain = 'https://www.repretel.com';
      } else if (
        hostname.includes('univisionnow.com') ||
        hostname.includes('univision.com') ||
        hostname.includes('tudn.com') ||
        hostname.includes('vix.com')
      ) {
        isUnivisionLikeSource = true;
        refererDomain = 'https://www.tudn.com/';
        originDomain = 'https://www.tudn.com';
      } else if (hostname.includes('akamaized.net') || hostname.includes('akamai.net')) {
        isAkamaiSource = true;
        refererDomain = 'https://www.redbull.com/';
        originDomain = 'https://www.redbull.com';
      }
    } catch (_) {
      // Mantener fallback TDMax si la URL llega incompleta o malformada
    }

    const isTeleticaSource = (() => {
      try {
        return new URL(effectiveSourceM3u8).hostname.toLowerCase().includes('teletica.com');
      } catch {
        return false;
      }
    })();
    const isProxyScrapedSource = PROXY_PROCESSES.has(String(process_id)) && isTeleticaSource;

    const hardenedLiveInputArgs = [];
    const isScrapedChannel = !!CHANNEL_MAP[process_id];
    // FUTV ALTERNO (17) NO está en CHANNEL_MAP (para no chocar en recovery con FUTV/11),
    // pero recibe la misma URL master de TDMax → necesita Variant Pinning igual que los scrapeados.
    // CANAL 6 URL (15) idem.
    const needsTdmaxLikePinning = isScrapedChannel || process_id === '17' || process_id === '15';

    if (isUnivisionLikeSource) {
      // Univision: minimal HLS flags, let the HLS demuxer handle everything internally.
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-live_start_index', '-3'
      );
    } else if (isAkamaiSource) {
      // Akamai CDN: VLC-like approach - reconnect básico + tolerancia alta.
      // Akamai acepta reconnect HTTP normal (no bloquea como Univision).
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-live_start_index', '-3',
        '-max_reload', '1000',
        '-m3u8_hold_counters', '1000'
      );
      sendLog(process_id, 'info', `🔧 Akamai CDN: modo resiliente con reconnect + hold counters`);
    } else if (isProxyScrapedSource) {
      // Tigo via Pi5 SOCKS5 — FASE 1 endurecida (Opción 3, Apr 2026):
      // Tras revertir Fase 2 (mini-proxy de tokens fallaba por nimblesessionid),
      // subimos la tolerancia del demuxer HLS a reloads para enmascarar visualmente
      // los reloads de Wowza/Nimble cuando rota el wmsAuthSign cada ~60s.
      //
      // Cambios respecto a la Fase 1 original:
      //  - max_reload 8 → 50: aceptamos más reintentos antes de matar el demuxer.
      //  - m3u8_hold_counters 10 → 50: tolerar más ciclos de "playlist sin nuevos
      //    segmentos" mientras el CDN rota la sesión.
      //  - rtbufsize/thread_queue_size: absorber jitter del SOCKS5.
      //  - max_delay 5s + genpts+discardcorrupt: tolerancia a paquetes corruptos.
      //  - SIN -http_persistent ni -multiple_requests (delatan scraper en Wowza).
      const liveStartIndex = isRecovery ? '-1' : '-2';
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-live_start_index', liveStartIndex,
        '-max_reload', '50',
        '-m3u8_hold_counters', '50',
        '-fflags', '+genpts+discardcorrupt',
        '-max_delay', '5000000',
        '-rtbufsize', '512M',
        '-thread_queue_size', '16384'
      );
      sendLog(process_id, 'info', `🌊 Tigo VLC-like (Fase 1 endurecida): max_reload=50, hold=50, start ${liveStartIndex}${isRecovery ? ' [recovery]' : ''}`);
    } else if (isManualProcess || needsTdmaxLikePinning) {
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-max_reload', '1000',
        '-m3u8_hold_counters', '1000',
        '-fflags', '+genpts'
      );
      sendLog(process_id, 'info', `🛡️ HLS resiliente: max_reload=1000, hold=1000`);
    }
    // Mantener -re como pacing de entrada para HLS live.
    // Quitar -re hace que FFmpeg lea a velocidad CPU, agote segmentos y termine en EOF.
    // Los reloads deben mitigarse fijando la variante HLS final antes de FFmpeg,
    // no dejando el master playlist completo al analizador interno.
    const usesReFlag = RE_FLAG_PROCESSES.has(String(process_id));
    if (usesReFlag) {
      hardenedLiveInputArgs.push('-re');
      sendLog(process_id, 'info', `📡 Perfil CON -re: lectura a tasa nativa, analyzeduration=${analyzeDuration}, probesize=${probeSize}`);
    } else {
      sendLog(process_id, 'info', `📡 Perfil SIN -re: salida real = ${CFR_OUTPUT_PROCESSES.has(String(process_id)) ? '29.97' : '30'}fps por -r${CFR_OUTPUT_PROCESSES.has(String(process_id)) ? '/-vsync cfr' : ''}`);
    }

    // Recuperar sesión de scraping cacheada (cookies + accessToken) para inyectar a FFmpeg
    const cachedSession = scrapeSessionCache.get(process_id);
    let extraFfmpegInputArgs = [];
    let authorizationHeader = null;
    let authorizationValue = null;
    let sessionCookies = null;
    if (cachedSession) {
      const sessionAge = Date.now() - cachedSession.timestamp;
      if (sessionAge < 600000) { // 10 minutos de TTL para cubrir recoveries lentos
        if (cachedSession.cookies) {
          sessionCookies = cachedSession.cookies;
          extraFfmpegInputArgs.push('-cookies', cachedSession.cookies + '\n');
          sendLog(process_id, 'info', `🍪 Inyectando cookies de sesión a FFmpeg`);
        }
        if (cachedSession.accessToken) {
          authorizationValue = `Bearer ${cachedSession.accessToken}`;
          authorizationHeader = `Authorization: ${authorizationValue}`;
          sendLog(process_id, 'info', `🔑 Inyectando accessToken a FFmpeg`);
        }
      } else {
        sendLog(process_id, 'warn', `⚠️ Sesión cacheada expirada (${Math.round(sessionAge/1000)}s), no se inyectan cookies`);
        scrapeSessionCache.delete(process_id);
      }
    }


    // Para procesos manuales con fuentes estables (Canal 6, Disney), usar args de resiliencia reforzados
    // reconnect_delay_max=15 da a FFmpeg hasta ~30s de reintentos internos (0+1+3+5+5+5+5=24s)
    // antes de salir, cubriendo caídas transitorias del CDN sin necesidad de recovery externo
    // IMPORTANTE: Univision/TUDN NO debe usar -reconnect_at_eof ni -reconnect_streamed
    // porque su CDN rechaza reconexiones HTTP a byte-offset, causando un loop infinito de EOF.
    // El demuxer HLS interno de FFmpeg ya maneja la rotación de segmentos correctamente.
    let effectiveResilienceArgs;
    if (isUnivisionLikeSource) {
      // Univision CDN bloquea reconexiones HTTP a byte-offset y detecta datacenter IPs.
      // Estrategia: CERO flags de reconnect HTTP. Dejar que el demuxer HLS interno
      // maneje la rotación de segmentos (es lo que VLC hace y funciona).
      // Solo rw_timeout para no colgar indefinidamente.
      effectiveResilienceArgs = [
        '-rw_timeout', '30000000',   // 30s timeout generoso
      ];
      sendLog(process_id, 'info', `🔧 Univision: modo VLC-like (sin reconnect HTTP, solo demuxer HLS)`);
    } else if (isMediatiqueSource) {
      // Mediatiquestream (Canal 6): tokens expiran, reconnect_at_eof causa loop infinito en 401.
      // Mantener reconnect básico para micro-cortes, pero sin reconnect_at_eof.
      effectiveResilienceArgs = [
        '-rw_timeout', '15000000',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_http_error', '5xx',
        '-reconnect_delay_max', '10',
      ];
      sendLog(process_id, 'info', `🔧 Mediatiquestream: reconnect sin reconnect_at_eof (evita loop 401)`);
    } else if (isAkamaiSource) {
      // Akamai CDN: modo VLC-like (igual que Disney 7/Univision).
      // reconnect_at_eof y reconnect_streamed causan reconexiones HTTP a byte-offset
      // que interrumpen el demuxer HLS interno, provocando reloads en el reproductor.
      // Estrategia: CERO flags de reconnect HTTP. Solo rw_timeout generoso.
      // El demuxer HLS interno de FFmpeg maneja la rotación de segmentos correctamente.
      effectiveResilienceArgs = [
        '-rw_timeout', '30000000',   // 30s timeout generoso (como Disney 7)
      ];
      sendLog(process_id, 'info', `🔧 Akamai CDN: modo VLC-like (sin reconnect HTTP, solo demuxer HLS)`);
    } else if (isProxyScrapedSource) {
      // Tigo/Teletica via Pi5: el token ya viene fresco del scraper, pero
      // reconnect_streamed/reconnect_at_eof rompen el demuxer HLS y provocan
      // loops de EOF/byte-offset (similar a VLC vs FFmpeg en otros CDNs).
      // Estrategia: dejar SOLO al demuxer HLS recargar playlists/segmentos.
      effectiveResilienceArgs = [
        '-rw_timeout', '30000000',
      ];
      sendLog(process_id, 'info', `🔧 Tigo/Teletica via Pi5: modo VLC-like (sin reconnect HTTP, solo demuxer HLS)`);
    } else if (isManualProcess) {
      effectiveResilienceArgs = [
        '-rw_timeout', '15000000',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_on_http_error', '4xx,5xx',
        '-reconnect_delay_max', '15',
      ];
    } else if (isRtmpInputSource) {
      effectiveResilienceArgs = [
        '-rtmp_live', 'live',
      ];
      sendLog(process_id, 'info', `🛰️ TIGO SRT: entrada SRT local (sin flags de reconnect HTTP)`);
    } else {
      effectiveResilienceArgs = HLS_INPUT_RESILIENCE_ARGS;
    }

    // Headers: Univision necesita headers Chrome completos para evadir detección de bots
    const univisionExtraHeaders = isUnivisionLikeSource ? [
      'Accept: */*',
      'Accept-Language: en-US,en;q=0.9',
      'Sec-Fetch-Dest: empty',
      'Sec-Fetch-Mode: cors',
      'Sec-Fetch-Site: cross-site',
      'Connection: keep-alive',
    ].join('\r\n') + '\r\n' : '';

    const combinedHeaders = [
      authorizationHeader,
      `Referer: ${refererDomain}`,
      `Origin: ${originDomain}`,
    ].filter(Boolean).join('\r\n') + '\r\n' + univisionExtraHeaders;

    // FASE 1: User-Agent rotativo para Tigo (proxy). Cada arranque/recovery
    // elige un UA distinto del pool → cada reconexión = "cliente nuevo" para Wowza.
    const sessionUserAgent = isProxyScrapedSource
      ? pickRandomUserAgent()
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    if (isProxyScrapedSource) {
      sendLog(process_id, 'info', `🎭 UA rotativo: ${sessionUserAgent.substring(0, 60)}...`);
    }

    const inputArgs = isRtmpInputSource
      ? [...effectiveResilienceArgs]
      : [
          ...effectiveResilienceArgs,
          ...extraFfmpegInputArgs,
          '-user_agent', sessionUserAgent,
          '-headers', combinedHeaders,
        ];

    // Para Tigo, FFmpeg ya apunta al proxy local, no necesita resolución de variante
    let inputSourceUrl = effectiveSourceM3u8;

    // ── PRE-CHECK DE SALUD EN ARRANQUE INICIAL ──
    // Verificar que la URL principal responda antes de lanzar FFmpeg.
    if (isManualProcess && !is_recovery) {
      sendLog(process_id, 'info', `🔍 Pre-check de salud antes de arrancar...`);
      const PRE_CHECK_ATTEMPTS = 3;
      const PRE_CHECK_INTERVAL = 3000;
      
      let primaryOk = false;
      for (let i = 1; i <= PRE_CHECK_ATTEMPTS; i++) {
        try {
          const resp = await fetch(effectiveSourceM3u8, { method: 'GET', signal: AbortSignal.timeout(5000) });
          if (resp.ok) { primaryOk = true; break; }
          sendLog(process_id, 'warn', `⚠️ URL principal: HTTP ${resp.status} (intento ${i}/${PRE_CHECK_ATTEMPTS})`);
        } catch (e) {
          sendLog(process_id, 'warn', `⚠️ URL principal: ${e.message || 'timeout'} (intento ${i}/${PRE_CHECK_ATTEMPTS})`);
        }
        if (i < PRE_CHECK_ATTEMPTS) await new Promise(r => setTimeout(r, PRE_CHECK_INTERVAL));
      }
      
      if (primaryOk) {
        sendLog(process_id, 'success', `✅ URL principal responde correctamente`);
      } else {
        sendLog(process_id, 'warn', `⚠️ URL principal no respondió en pre-check. Iniciando FFmpeg de todos modos.`);
      }
    }

    // === Estrategia de selección de variante HLS ===
    // MANUALES (Disney): pinnear URL hija directa (tokens largos/inexistentes)
    // MEDIATIQUESTREAM (Canal 6): program mapping (tokens expiran, master playlist debe vivir)
    // SCRAPEADOS (TDMax): mantener master playlist vivo (token de 1min necesita renovación del CDN)
    //   pero forzar el programa 720p con -map 0:p:N para evitar cambios de calidad
    const isManualUrlProcess = isManualProcess;
    let hlsProgramIndex = -1; // -1 = sin forzar programa específico

    if (isMediatiqueSource) {
      // Canal 6 / Mediatiquestream: usar program mapping como canales scrapeados.
      // Mantener master playlist vivo para que el CDN refresque tokens de segmentos.
      try {
        const { bandwidth, resolution, allVariants } = await resolveBestHLSVariant(inputSourceUrl, {
          targetBandwidth: 0,
          headers: {
            Referer: refererDomain,
            Origin: originDomain,
            ...(authorizationValue ? { Authorization: authorizationValue } : {}),
          },
          cookies: sessionCookies,
        });

        const validVariants = (allVariants || []).filter(v => v.bandwidth > 0 && v.resolution);
        if (validVariants.length > 0) {
          const target720 = validVariants.find(v => v.resolution && v.resolution.includes('720'));
          const best = target720 || validVariants[validVariants.length - 1];
          hlsProgramIndex = best.programIndex;
          sendLog(process_id, 'success', `📺 Programa HLS fijado → p:${hlsProgramIndex} (${best.resolution} @ ${Math.round(best.bandwidth / 1000)}kbps) [master vivo, program mapping]`);
        }
      } catch (err) {
        sendLog(process_id, 'warn', `⚠️ No se pudo analizar master HLS: ${err.message} — FFmpeg elegirá automáticamente`);
      }
    } else if (isManualUrlProcess && !isUnivisionLikeSource && !isAkamaiSource && !isRtmpInputSource) {
      // Canales manuales con tokens estables: resolver y pinnear URL hija directamente
      const { resolvedUrl, bandwidth, resolution, allVariants } = await resolveBestHLSVariant(inputSourceUrl, {
        targetBandwidth: 0,
        headers: {
          Referer: refererDomain,
          Origin: originDomain,
          ...(authorizationValue ? { Authorization: authorizationValue } : {}),
        },
        cookies: sessionCookies,
      });

      const validVariants = (allVariants || []).filter(v => v.bandwidth > 0);

      if (validVariants.length > 0 && bandwidth === 0) {
        const bestValid = validVariants[validVariants.length - 1];
        let bestUrl = bestValid.url;
        if (!bestUrl.startsWith('http')) {
          bestUrl = new URL(bestUrl, new URL(inputSourceUrl)).toString();
        }
        inputSourceUrl = bestUrl;
        sendLog(process_id, 'success', `📺 Variante HLS fijada → ${bestValid.resolution || '?'} @ ${Math.round(bestValid.bandwidth / 1000)}kbps`);
      } else if (bandwidth > 0) {
        inputSourceUrl = resolvedUrl;
        sendLog(process_id, 'success', `📺 Variante HLS fijada → ${resolution} @ ${Math.round(bandwidth / 1000)}kbps`);
      } else {
        sendLog(process_id, 'info', `📺 Fuente: URL directa`);
      }
    } else if (isUnivisionLikeSource) {
      // Univision/TUDN: NO usar -map 0:p:N porque el manifiesto tiene programas con
      // subtítulos EIA-608 que confunden a FFmpeg al mapear por programa.
      // Estrategia: dejar FFmpeg auto-seleccionar (elige el mejor stream automáticamente)
      // y filtrar solo video+audio con -map genéricos. La escala -vf scale:-2:720 ya 
      // normaliza la resolución de salida.
      sendLog(process_id, 'info', `📺 Univision: auto-selección FFmpeg (sin -map p:N, evita conflicto subtítulos)`);
      // hlsProgramIndex stays -1, will use '-map', '0:v:0?', '-map', '0:a:0?'
    } else if (isAkamaiSource) {
      // Akamai CDN (Red Bull, etc.): la URL ya es una variante específica (master_6660.m3u8)
      // Pasar directo a FFmpeg sin resolución de variantes. Usar map genérico video+audio.
      sendLog(process_id, 'info', `📺 Akamai: URL directa sin resolución de variante`);
      // hlsProgramIndex stays -1, will use '-map', '0:v:0?', '-map', '0:a:0?'
    } else if (isScrapedChannel && isProxyScrapedSource) {
      // Tigo via Pi5 (Fase 1 endurecida) — Variant Pinning manual.
      // Resolvemos el master playlist UNA vez aquí (no FFmpeg) y pasamos
      // directamente la sub-playlist 720p para que FFmpeg no abra las 4
      // variantes en paralelo (lo que Wowza/Nimble penaliza con 403).
      try {
        const masterResp = await fetchWithOptionalProxy(inputSourceUrl, {
          headers: {
            'User-Agent': sessionUserAgent,
            Referer: refererDomain,
            Origin: originDomain,
            ...(authorizationValue ? { Authorization: authorizationValue } : {}),
            ...(sessionCookies ? { Cookie: sessionCookies } : {}),
          },
        }, true);
        if (masterResp.ok) {
          const body = await masterResp.text();
          if (body.includes('#EXT-X-STREAM-INF')) {
            const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
            const variants = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const resMatch = lines[i].match(/RESOLUTION=([\dx]+)/);
                const variantUrl = lines[i + 1];
                if (variantUrl && !variantUrl.startsWith('#')) {
                  variants.push({
                    bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
                    resolution: resMatch ? resMatch[1] : null,
                    url: variantUrl,
                  });
                }
              }
            }
            if (variants.length > 0) {
              const target720 = variants.find(v => v.resolution && v.resolution.includes('720'));
              const best = target720 || variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
              let pinnedUrl = best.url;
              if (!pinnedUrl.startsWith('http')) {
                pinnedUrl = new URL(pinnedUrl, inputSourceUrl).toString();
              }
              inputSourceUrl = pinnedUrl;
              sendLog(process_id, 'success', `📌 Tigo Variant Pinning → ${best.resolution || '?'} @ ${Math.round((best.bandwidth || 0) / 1000)}kbps`);
            }
          } else {
            sendLog(process_id, 'info', `📺 Tigo: URL ya es sub-playlist directa (sin master)`);
          }
        }
      } catch (err) {
        sendLog(process_id, 'warn', `⚠️ Tigo Variant Pinning falló (${err.message}) — usando URL original`);
      }
    } else if (needsTdmaxLikePinning) {
      // Canales scrapeados (NO proxy): mantener master playlist vivo (token de 1min necesita renovación del CDN)
      // pero sí identificar el programa 720p para forzarlo con -map
      try {
        const { bandwidth, resolution, allVariants } = await resolveBestHLSVariant(inputSourceUrl, {
          targetBandwidth: 0,
          headers: {
            Referer: refererDomain,
            Origin: originDomain,
            ...(authorizationValue ? { Authorization: authorizationValue } : {}),
          },
          cookies: sessionCookies,
        });

        const validVariants = (allVariants || []).filter(v => v.bandwidth > 0 && v.resolution);
        if (validVariants.length > 0) {
          // Política: SOLO 720p preferido, 1080p como fallback. Sin saltos dinámicos posteriores.
          const target720 = validVariants.find(v => v.resolution && v.resolution.includes('720'));
          const target1080 = validVariants.find(v => v.resolution && v.resolution.includes('1080'));
          const best = target720 || target1080 || validVariants[validVariants.length - 1];
          hlsProgramIndex = best.programIndex;
          sendLog(process_id, 'success', `📌 Variant Pinning → p:${hlsProgramIndex} (${best.resolution} @ ${Math.round(best.bandwidth / 1000)}kbps) [SIN ABR]`);
        } else if (allVariants && allVariants.length > 0) {
          const sorted = [...allVariants].filter(v => v.bandwidth > 0).sort((a,b) => b.bandwidth - a.bandwidth);
          if (sorted.length > 0) {
            hlsProgramIndex = sorted[0].programIndex;
            sendLog(process_id, 'success', `📺 Programa HLS fijado → p:${hlsProgramIndex} (${Math.round(sorted[0].bandwidth / 1000)}kbps) [master vivo]`);
          }
        }
      } catch (err) {
        sendLog(process_id, 'warn', `⚠️ No se pudo analizar master HLS: ${err.message} — FFmpeg elegirá automáticamente`);
      }
    }

    // Nombre del proceso para logs
    const channelLabels = { '0': 'Disney 7', '1': 'FUTV', '3': 'TDmas 1', '4': 'Teletica', '5': 'Canal 6', '6': 'Multimedios', '7': 'Subida', '10': 'Disney 8', '11': 'FUTV URL', '12': 'TIGO SRT', '13': 'TELETICA URL', '14': 'TDMAS 1 URL', '15': 'CANAL 6 URL', '16': 'DISNEY 7 SRT', '17': 'FUTV ALTERNO', '18': 'FUTV SRT' };
    const procName = channelLabels[String(process_id)] || `Proceso ${process_id}`;
    sendLog(process_id, 'info', `🎬 ${procName}: CBR 2000k 720p30 AAC128k GOP2s (preset veryfast)${isRecovery ? ' [recovery]' : ''}`);

    // Procesos CFR: usar fps nativo (29.97) + vsync cfr para cadencia constante al RTMP
    // Esto evita micro-jitter por forzar 30fps en una fuente 29.97fps (frame duplicado cada ~33s)
    const isCfrOutput = CFR_OUTPUT_PROCESSES.has(String(process_id));
    const outputFps = isCfrOutput ? '29.97' : '30';
    const gopSize = isCfrOutput ? '59.94' : '60'; // GOP = 2 segundos a fps nativo

    const fflags = (isUnivisionLikeSource || isAkamaiSource) ? '+genpts+discardcorrupt' : '+genpts';

    ffmpegArgs = [
      ...inputArgs,
      ...hardenedLiveInputArgs,
      '-fflags', fflags,
      '-analyzeduration', (isUnivisionLikeSource || isAkamaiSource || isProxyScrapedSource) ? '10000000' : analyzeDuration,  // 10s para VLC-like profiles + proxy
      '-probesize', (isUnivisionLikeSource || isAkamaiSource || isProxyScrapedSource) ? '5000000' : probeSize,               // 5MB para VLC-like profiles + proxy
      '-i', inputSourceUrl,
      // Univision: auto-selección + skip subtítulos EIA-608
      // Scrapeados: map por programa HLS
      // Otros: map genérico video+audio
      ...(isUnivisionLikeSource
        ? ['-map', '0:v:3?', '-map', '0:a:3?', '-sn']  // Stream #0:10 (720p Program 3) + Audio #0:9
        : hlsProgramIndex >= 0
        ? ['-map', `0:p:${hlsProgramIndex}:v?`, '-map', `0:p:${hlsProgramIndex}:a?`]
        : ['-map', '0:v:0?', '-map', '0:a:0?']),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-threads', '4',
      '-b:v', '2000k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-vf', 'scale=-2:720',
      '-r', outputFps,
      ...(isCfrOutput ? ['-vsync', 'cfr'] : []),
      '-g', gopSize,
      '-keyint_min', gopSize,
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-max_muxing_queue_size', '1024',
      '-reset_timestamps', '1',
    ];

    // === OUTPUT: HLS local o RTMP ===
    // Para Tigo (ID 12) con buffer activo: FFmpeg #1 escribe HLS CRUDO (-c copy)
    // a /tmp/tigo-buffer-12 sin transcoding. FFmpeg #2 (más abajo) transcodea
    // desde el buffer local al output final que consume el TV.
    // Tigo (ID 12): el buffer se activa si es scraping vía proxy O si es modo HDMI.
    // En modo HDMI, la ETAPA 1 es un FFmpeg SRT listener que recibe del Pi5;
    // más abajo interceptamos el spawn para usar startTigoHdmiIngest() en vez
    // de proxychains/CDN.
    const isTigoHdmiMode = String(process_id) === '12' && TIGO_USE_HDMI;
    const useTigoBuffer = false;
    const isSrtIngestMode = isSrtIngestProcess(process_id) && (
      !source_m3u8 ||
      String(source_m3u8).startsWith('srt://obs') ||
      String(source_m3u8).startsWith('srt://0.0.0.0')
    );
    const srtIngestCfg = isSrtIngestMode ? getSrtConfig(process_id) : null;

    if (useTigoBuffer) {
      // Sobrescribir args de salida: NO transcodear aquí, solo remuxear a HLS local.
      // Quitamos las flags de transcoding que ya estaban en ffmpegArgs.
      const transcodeFlagsToStrip = new Set([
        '-c:v','-preset','-profile:v','-threads','-b:v','-maxrate','-bufsize',
        '-vf','-r','-vsync','-g','-keyint_min','-sc_threshold','-c:a','-b:a','-ar',
        '-max_muxing_queue_size','-reset_timestamps'
      ]);
      const stripped = [];
      for (let i = 0; i < ffmpegArgs.length; i++) {
        if (transcodeFlagsToStrip.has(ffmpegArgs[i])) { i++; continue; }
        stripped.push(ffmpegArgs[i]);
      }
      ffmpegArgs = stripped;

      cleanTigoBufferDir();
      ffmpegArgs.push(
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '10',
        '-hls_list_size', '8',
        '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(TIGO_BUFFER_DIR, 'buf_%05d.ts'),
        '-hls_allow_cache', '0',
        '-hls_start_number_source', 'epoch',
        TIGO_BUFFER_PLAYLIST
      );
      sendLog(process_id, 'info', `🌊 Tigo BUFFER ETAPA 1 → ${TIGO_BUFFER_PLAYLIST} (-c copy, 10s seg × 8 = ~80s en disco)`);
    } else if (isHlsOutput) {
      const hlsSlug = HLS_SLUG_MAP[process_id] || `stream_${process_id}`;
      const hlsDir = path.join(HLS_OUTPUT_DIR, hlsSlug);
      if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
      }
      // Limpiar segmentos anteriores
      try {
        const oldFiles = fs.readdirSync(hlsDir);
        for (const f of oldFiles) {
          fs.unlinkSync(path.join(hlsDir, f));
        }
      } catch (_) {}

      const hlsPlaylistPath = path.join(hlsDir, 'playlist.m3u8');
      ffmpegArgs.push(
        '-f', 'hls',
        '-hls_time', '10',
        '-hls_list_size', '8',
        '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
        '-hls_allow_cache', '0',
        '-hls_start_number_source', 'epoch',  // Números de segmento únicos por sesión
        hlsPlaylistPath
      );
      sendLog(process_id, 'success', `📺 HLS Output → /live/${hlsSlug}/playlist.m3u8 (10s×8, estable)`);
    } else {
      ffmpegArgs.push(
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp,
      );
    }

    // ── MODO HDMI (Tigo ID 12): SRT listener en vez de proxychains/CDN ──
    // Si TIGO_USE_HDMI=true (default), descartamos los args HLS de scraping y
    // arrancamos un FFmpeg SRT listener que recibe del Pi5. Toda la lógica de
    // recovery/cierre de abajo sigue funcionando porque registramos el proceso
    // en `ffmpegProcesses` igual que en el flujo normal.
    let spawnCmd = 'ffmpeg';
    let spawnArgs = ffmpegArgs;
    let ffmpegProcess;

    if (isTigoHdmiMode) {
      sendLog(process_id, 'info', `📡 Tigo HDMI: arrancando SRT listener en :${TIGO_SRT_PORT} (esperando Pi5...)`);
      const ingest = startTigoHdmiIngest(process_id);
      ffmpegProcess = ingest.process;
      spawnCmd = 'ffmpeg';
      spawnArgs = ingest.args;
      sendLog(process_id, 'success', `🛰️ ETAPA 1 HDMI activa: srt://0.0.0.0:${TIGO_SRT_PORT} → ${TIGO_BUFFER_PLAYLIST}`);
    } else if (isSrtIngestMode) {
      const cfg = srtIngestCfg;
      sendLog(process_id, 'info', `📡 ${cfg.label}: arrancando listener en :${cfg.port} (esperando OBS...)`);
      const ingest = startSrtIngest(process_id);
      ffmpegProcess = ingest.process;
      spawnCmd = 'ffmpeg';
      spawnArgs = ingest.args;
      const encInfo = cfg.passphrase ? '🔐 AES-128' : '⚠️ sin encriptación';
      sendLog(process_id, 'success', `🛰️ ETAPA 1 SRT activa: srt://0.0.0.0:${cfg.port} → ${cfg.bufferPlaylist} (${encInfo}, latency=${cfg.latencyMs}ms)`);
    } else if (PROXY_PROCESSES.has(process_id)) {
      // ── MODO PROXY (legacy/fallback): proxychains4 → CDN HLS ──
      sendLog(process_id, 'info', `🔍 Verificando salud del proxy SOCKS5 (Pi5 CR)...`);
      const health = await updateProxyHealth();
      if (!health.reachable) {
        const errMsg = `Proxy SOCKS5 (Pi5 CR) no responde: ${health.error}. Verificá el Pi5 (energía, Wi-Fi, microsocks).`;
        sendLog(process_id, 'error', `❌ ${errMsg}`);
        await stopTigoProxy(process_id);
        if (supabase) {
          await supabase.from('emission_processes').update({
            is_active: false, is_emitting: false, emit_status: 'error',
            failure_reason: 'proxy_down', failure_details: errMsg,
            ended_at: new Date().toISOString(), start_time: 0,
          }).eq('id', parseInt(process_id));
        }
        emissionStatuses.set(process_id, 'idle');
        return res.status(502).json({ error: errMsg, failure_reason: 'proxy_down' });
      }
      sendLog(process_id, 'success', `✅ Proxy SOCKS5 OK (latencia ${health.latencyMs}ms)`);

      if (tigoProxies.has(String(process_id))) {
        sendLog(process_id, 'success', `🛡️ FFmpeg consumirá del proxy local (Fase 2 activa)`);
      } else {
        if (!isProxychainsAvailable()) {
          sendLog(process_id, 'error', `❌ proxychains4 no está instalado en el VPS. Ejecuta: apt install -y proxychains4`);
          return res.status(500).json({ error: 'proxychains4 no instalado en el VPS' });
        }
        const confPath = ensureProxychainsConf();
        if (!confPath) {
          sendLog(process_id, 'error', `❌ No se pudo generar config de proxychains`);
          return res.status(500).json({ error: 'Error generando config de proxychains' });
        }
        spawnCmd = 'proxychains4';
        spawnArgs = ['-q', '-f', confPath, 'ffmpeg', ...ffmpegArgs];
        sendLog(process_id, 'warn', `⚠️ Fase 1 fallback activo: FFmpeg vía proxychains4 (sin token refresh proactivo)`);
      }
    }

    const commandStr = spawnCmd + ' ' + spawnArgs.join(' ');
    sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 120)}...`);

    // Si no es modo HDMI, spawneamos aquí. En modo HDMI ya quedó spawneado arriba.
    if (!ffmpegProcess) {
      ffmpegProcess = spawn(spawnCmd, spawnArgs);
    }
    const processInfo = {
      process: ffmpegProcess,
      status: 'starting',
      startTime: Date.now(),
      target_rtmp: target_rtmp,
      source_m3u8: effectiveSourceM3u8
    };
    ffmpegProcesses.set(process_id, processInfo);

    if (supabase) {
      await supabase
        .from('emission_processes')
        .update({
          ffmpeg_pid: ffmpegProcess.pid,
          start_time: dbRecord?.start_time || Math.floor(Date.now() / 1000),
          ended_at: null,
        })
        .eq('id', parseInt(process_id));
    }

    // ── Keep-alive del playlist Tigo (Opción B) ──
    // Mantiene caliente la sesión nimblesessionid para evitar que el CDN
    // la marque como idle y rote (causa probable de los reloads ciegos de 2-3s).
    // En modo HDMI no hay sesión CDN que mantener viva.
    if (PROXY_PROCESSES.has(String(process_id)) && !isTigoHdmiMode) {
      startTigoKeepAlive(process_id, effectiveSourceM3u8, sessionUserAgent);
    }

    // ── Parser de métricas SRT + LOG CRUDO (solo modo HDMI ID 12) ──
    // El stderr de FFmpeg con -stats imprime cada ~1s una línea con bitrate y frame.
    // Cuando llega la primera línea con frame > 0 → marcamos `connected = true`.
    // ADEMÁS: logueamos TODO stderr de Etapa 1 al log del proceso para diagnóstico
    // de fallos de handshake SRT (que de otra forma serían silenciosos).
    if (isTigoHdmiMode) {
      ffmpegProcess.stderr.on('data', (data) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Diagnóstico: loguear líneas relevantes (no spam de "frame=")
          if (!/^frame=|^size=/.test(trimmed)) {
            sendLog(process_id, 'info', `[ETAPA1-SRT] ${trimmed.substring(0, 220)}`);
          }
          const m = parseFfmpegProgress(trimmed);
          if (m.frame !== undefined && m.frame > 0) {
            updateTigoSrtMetric(process_id, {
              connected: true,
              lastFrameAt: Date.now(),
              ...(m.bitrateKbps !== undefined ? { bitrateKbps: m.bitrateKbps } : {}),
            });
          }
          // Detectar paquetes perdidos en logs SRT (formato: "lost: N")
          const lostMatch = trimmed.match(/SRT.*lost\s*[:=]\s*(\d+)/i);
          if (lostMatch) {
            const cur = tigoSrtMetrics.get(String(process_id))?.pktsLost || 0;
            updateTigoSrtMetric(process_id, { pktsLost: cur + parseInt(lostMatch[1], 10) });
          }
          // Detectar reset de conexión SRT
          if (/Connection (lost|timed out)/i.test(trimmed) || /SRT.*disconnect/i.test(trimmed)) {
            updateTigoSrtMetric(process_id, { connected: false });
          }
        }
      });
    }

    // ── Parser de métricas SRT genérico (Disney 7 / Tigo / FUTV) ──
    if (isSrtIngestMode) {
      ffmpegProcess.stderr.on('data', (data) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!/^frame=|^size=/.test(trimmed)) {
            sendLog(process_id, 'info', `[ETAPA1-SRT] ${trimmed.substring(0, 220)}`);
          }
          const m = parseFfmpegProgress(trimmed);
          if (m.frame !== undefined && m.frame > 0) {
            updateTigoSrtMetric(process_id, {
              connected: true,
              lastFrameAt: Date.now(),
              ...(m.bitrateKbps !== undefined ? { bitrateKbps: m.bitrateKbps } : {}),
            });
          }
          const lostMatch = trimmed.match(/SRT.*lost\s*[:=]\s*(\d+)/i);
          if (lostMatch) {
            const cur = tigoSrtMetrics.get(String(process_id))?.pktsLost || 0;
            updateTigoSrtMetric(process_id, { pktsLost: cur + parseInt(lostMatch[1], 10) });
          }
          if (/Connection (lost|timed out)/i.test(trimmed) || /SRT.*disconnect/i.test(trimmed)) {
            updateTigoSrtMetric(process_id, { connected: false });
          }
        }
      });
    }

    // ── Buffer Tigo ETAPA 2 ─────────────────────────────────────────
    // Tras spawnear FFmpeg #1 (ingest crudo a /tmp/tigo-buffer-12), esperamos
    // a que existan ≥3 segmentos en el buffer y arrancamos FFmpeg #2 (transcoder
    // local) que lee del disco con -re y escribe al output final que consume el TV.
    // FFmpeg #2 NO toca el CDN de Teletica → 0 riesgo de baneo adicional.
    if (useTigoBuffer) {
      (async () => {
        const slug = HLS_SLUG_MAP[process_id] || `stream_${process_id}`;
        const outDir = path.join(HLS_OUTPUT_DIR, slug);
        try {
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          for (const f of fs.readdirSync(outDir)) {
            try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
          }
        } catch (_) {}

        sendLog(process_id, 'info', `⏳ Tigo BUFFER ETAPA 2: esperando ≥${TIGO_BUFFER_MIN_SEGMENTS} segmentos en buffer...`);
        const ready = await waitForTigoBufferReady();
        if (!ready.ready) {
          sendLog(process_id, 'error', `❌ Tigo BUFFER: timeout (${ready.waitedMs}ms) esperando segmentos. Etapa 1 puede estar fallando.`);
          return;
        }
        sendLog(process_id, 'success', `✅ Tigo BUFFER listo (${ready.segments} segs en ${ready.waitedMs}ms) — spawneando ETAPA 2`);

        const spawnOutputStage = () => {
          // Si hubo parada manual mientras esperábamos, abortar
          if (manualStopProcesses.has(process_id) || manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
            return;
          }
          const ingestProc = ffmpegProcesses.get(process_id);
          if (!ingestProc || !ingestProc.process || ingestProc.process.killed) {
            sendLog(process_id, 'warn', `⚠️ Tigo BUFFER ETAPA 2: ETAPA 1 no está viva, abortando spawn`);
            return;
          }

          const outPlaylist = path.join(outDir, 'playlist.m3u8');
          const stage2Args = [
            '-re',
            '-fflags', '+genpts+discardcorrupt',
            '-analyzeduration', '3000000',
            '-probesize', '1500000',
            '-i', TIGO_BUFFER_PLAYLIST,
            '-map', '0:v:0?',
            '-map', '0:a:0?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'main',
            '-threads', '4',
            '-b:v', '2000k',
            '-maxrate', '2000k',
            '-bufsize', '4000k',
            '-vf', 'scale=-2:720',
            '-r', '29.97',
            '-vsync', 'cfr',
            '-g', '59.94',
            '-keyint_min', '59.94',
            '-sc_threshold', '0',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-max_muxing_queue_size', '1024',
            '-reset_timestamps', '1',
            '-f', 'hls',
            '-hls_time', '4',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments+append_list+independent_segments',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
            '-hls_allow_cache', '1',
            '-hls_start_number_source', 'epoch',
            outPlaylist,
          ];
          const stage2 = spawn('ffmpeg', stage2Args);
          tigoOutputProcesses.set(String(process_id), stage2);
          sendLog(process_id, 'success', `🎬 Tigo BUFFER ETAPA 2 → /live/${slug}/playlist.m3u8 (transcode local 720p CBR 2000k)`);

          stage2.stderr.on('data', (data) => {
            const out = data.toString();
            // Silencioso: solo errores reales
            if (/error|failed|Invalid/i.test(out) && !/frame=/.test(out)) {
              const line = out.split('\n').find(l => /error|failed|Invalid/i.test(l));
          if (line && !line.includes('failed to delete old segment')) sendLog(process_id, 'warn', `[ETAPA2] ${line.trim().substring(0, 180)}`);
            }
          });

          stage2.on('close', (code, signal) => {
            tigoOutputProcesses.delete(String(process_id));
            const stillRunning = ffmpegProcesses.get(process_id);
            const isAlive = stillRunning && stillRunning.process && !stillRunning.process.killed;
            const wasManual = manualStopProcesses.has(process_id) || manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id));
            if (wasManual || !isAlive) {
              sendLog(process_id, 'info', `🛑 Tigo BUFFER ETAPA 2 terminada (code=${code}, signal=${signal || '-'})`);
              return;
            }
            // ETAPA 1 sigue viva → reiniciar ETAPA 2 sin tocar el CDN
            sendLog(process_id, 'warn', `🔁 Tigo BUFFER ETAPA 2 cayó (code=${code}) — reiniciando en 2s (ETAPA 1 sigue viva)`);
            setTimeout(spawnOutputStage, 2000);
          });
        };

        spawnOutputStage();
      })().catch(err => {
        sendLog(process_id, 'error', `❌ Tigo BUFFER ETAPA 2 error: ${err.message}`);
      });
    }

    // ── SRT BUFFER ETAPA 2 (Tigo / Disney 7 / FUTV SRT) ─────────────
    // Tras spawnear el SRT listener (ETAPA 1), espera ≥3 segs en buffer
    // y arranca un transcoder local que lee del buffer del proceso
    // y emite a /live/<slug>/playlist.m3u8 (lo que consumen los usuarios).
    if (isSrtIngestMode) {
      const cfg = srtIngestCfg;
      (async () => {
        const slug = HLS_SLUG_MAP[process_id] || `stream_${process_id}`;
        const outDir = path.join(HLS_OUTPUT_DIR, slug);
        try {
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          for (const f of fs.readdirSync(outDir)) {
            try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
          }
        } catch (_) {}

        sendLog(process_id, 'info', `⏳ ${cfg.label} BUFFER ETAPA 2: esperando ≥${cfg.minSegments} segmentos SRT...`);
        const ready = await waitForSrtBufferReady(cfg);
        if (!ready.ready) {
          sendLog(process_id, 'error', `❌ ${cfg.label} BUFFER: timeout (${ready.waitedMs}ms). ¿OBS está conectado al SRT?`);
          return;
        }
        sendLog(process_id, 'success', `✅ ${cfg.label} BUFFER listo (${ready.segments} segs en ${ready.waitedMs}ms) — spawneando ETAPA 2`);

        let stage2RetryCount = 0;
        const STAGE2_MAX_RETRIES = 10;
        const spawnSrtOutputStage = () => {
          if (manualStopProcesses.has(process_id) || manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
            return;
          }
          const ingestProc = ffmpegProcesses.get(process_id);
          if (!ingestProc || !ingestProc.process || ingestProc.process.killed) {
            sendLog(process_id, 'warn', `⚠️ ${cfg.label} ETAPA 2: ETAPA 1 no está viva, abortando spawn`);
            return;
          }

          const outPlaylist = path.join(outDir, 'playlist.m3u8');
          const stage2Args = [
            '-re',
            '-fflags', '+genpts+discardcorrupt',
            '-analyzeduration', '3000000',
            '-probesize', '1500000',
            '-i', cfg.bufferPlaylist,
            '-map', '0:v:0?',
            '-map', '0:a:0?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'main',
            '-threads', '4',
            '-b:v', '2000k',
            '-maxrate', '2000k',
            '-bufsize', '4000k',
            '-vf', 'scale=-2:720',
            '-r', '30',
            '-vsync', 'cfr',
            '-g', '60',
            '-keyint_min', '60',
            '-sc_threshold', '0',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '48000',
            '-max_muxing_queue_size', '1024',
            '-reset_timestamps', '1',
            '-f', 'hls',
            '-hls_time', '4',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments+append_list+independent_segments',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
            '-hls_allow_cache', '1',
            '-hls_start_number_source', 'epoch',
            outPlaylist,
          ];
          const stage2 = spawn('ffmpeg', stage2Args);
          tigoOutputProcesses.set(String(process_id), stage2);
          sendLog(process_id, 'success', `🎬 ${cfg.label} BUFFER ETAPA 2 → /live/${slug}/playlist.m3u8 (transcode 720p CBR 2000k @ 30fps)`);

          stage2.stderr.on('data', (data) => {
            const out = data.toString();
            if (/error|failed|Invalid/i.test(out) && !/frame=/.test(out)) {
              const line = out.split('\n').find(l => /error|failed|Invalid/i.test(l));
              if (line && !line.includes('failed to delete old segment')) sendLog(process_id, 'warn', `[ETAPA2] ${line.trim().substring(0, 180)}`);
            }
          });

          stage2.on('close', (code, signal) => {
            tigoOutputProcesses.delete(String(process_id));
            const stillRunning = ffmpegProcesses.get(process_id);
            const isAlive = stillRunning && stillRunning.process && !stillRunning.process.killed;
            const wasManual = manualStopProcesses.has(process_id) || manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id));
            if (wasManual || !isAlive) {
              sendLog(process_id, 'info', `🛑 ${cfg.label} ETAPA 2 terminada (code=${code}, signal=${signal || '-'})`);
              return;
            }
            stage2RetryCount++;
            if (stage2RetryCount > STAGE2_MAX_RETRIES) {
              sendLog(process_id, 'error', `❌ ${cfg.label} ETAPA 2 falló ${STAGE2_MAX_RETRIES} veces consecutivas — abortando reintentos. Revisar buffer/codec.`);
              return;
            }
            sendLog(process_id, 'warn', `🔁 ${cfg.label} ETAPA 2 reintento ${stage2RetryCount}/${STAGE2_MAX_RETRIES} (code=${code}) en 2s`);
            setTimeout(spawnSrtOutputStage, 2000);
          });
        };

        spawnSrtOutputStage();
      })().catch(err => {
        sendLog(process_id, 'error', `❌ ${cfg.label} BUFFER ETAPA 2 error: ${err.message}`);
      });
    }


    // (Monitor del mini-proxy Tigo eliminado — Fase 2 revertida.)

    // Manejar salida estándar
    ffmpegProcess.stdout.on('data', (data) => {
      const output = data.toString();
      sendLog(process_id, 'info', `FFmpeg stdout: ${output.trim()}`);
    });

    // Buffer para capturar las últimas líneas de stderr (diagnóstico de crashes)
    const stderrBuffer = [];
    const MAX_STDERR_LINES = 15;

    // ── Throttle + detector de stall para "Failed to open segment" ──
    // Cuenta failures en una ventana de 10s. Si pasan >25 sin avance de
    // frame, dispara restart automático (re-login + UA fresco) en vez de
    // esperar 45s al watchdog. Además agrupa el spam de logs.
    const segFailState = {
      count: 0,
      windowStart: Date.now(),
      lastFlush: 0,
      lastFrameAtCheck: 0,
      restartTriggered: false,
    };
    const SEG_FAIL_WINDOW_MS = 10_000;
    const SEG_FAIL_STALL_THRESHOLD = 25;
    const SEG_FAIL_FLUSH_INTERVAL = 5_000;

    // Manejar errores con análisis mejorado
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Guardar en buffer circular para diagnóstico
      const lines = output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        stderrBuffer.push(line.trim());
        if (stderrBuffer.length > MAX_STDERR_LINES) stderrBuffer.shift();
      }

      // ── Interceptar "Failed to open segment" ANTES del logging normal ──
      if (output.includes('Failed to open segment')) {
        const now = Date.now();
        // Reset ventana cada 10s
        if (now - segFailState.windowStart > SEG_FAIL_WINDOW_MS) {
          segFailState.windowStart = now;
          segFailState.count = 0;
          segFailState.lastFrameAtCheck = lastFrameTime.get(process_id) || 0;
        }
        segFailState.count += (output.match(/Failed to open segment/g) || []).length;

        // Flush agrupado cada 5s (evita spam visual)
        if (now - segFailState.lastFlush >= SEG_FAIL_FLUSH_INTERVAL && segFailState.count > 0) {
          sendLog(process_id, 'warn', `⚠️ HLS: ${segFailState.count} segmentos fallidos en ${Math.round((now - segFailState.windowStart)/1000)}s (CDN inestable, FFmpeg saltando)`);
          segFailState.lastFlush = now;
        }

        // Detector de stall: muchos failures + frame= no avanzó → restart auto
        if (
          segFailState.count >= SEG_FAIL_STALL_THRESHOLD &&
          !segFailState.restartTriggered &&
          (CHANNEL_MAP[process_id] || process_id === '17' || process_id === '15')
        ) {
          const lastFrame = lastFrameTime.get(process_id) || 0;
          const frameStalledMs = now - lastFrame;
          if (frameStalledMs > 8000) {
            segFailState.restartTriggered = true;
            sendLog(process_id, 'error', `🚨 STALL detectado: ${segFailState.count} fails + frame congelado ${Math.round(frameStalledMs/1000)}s → restart automático`);
            // Disparar restart asíncrono (re-login + UA fresco)
            try {
              scrapeSessionCache.delete(process_id);
              if (typeof ffmpegProcess.kill === 'function') {
                ffmpegProcess.kill('SIGTERM');
                setTimeout(() => {
                  try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
                }, 3000);
              }
            } catch (e) {
              console.error('Error en stall-restart:', e);
            }
          }
        }
        return; // No pasar al logger normal (ya lo agrupamos)
      }

      // ── Logging quirúrgico Tigo: clasificar micro-cortes silenciosos ──
      // Detectamos eventos que NO matan FFmpeg pero causan gaps de 2-3s en TV.
      if (PROXY_PROCESSES.has(String(process_id))) {
        if (/HTTP error 404/.test(output) && /\.ts/.test(output)) {
          sendLog(process_id, 'info', `🔄 CDN rotó sesión (404 segmento) — playlist se recargará`);
        } else if (/HTTP error 403/.test(output)) {
          sendLog(process_id, 'info', `🔑 Token wmsAuthSign expirado (403)`);
        } else if (/Opening '.*\.m3u8'/.test(output)) {
          sendLog(process_id, 'info', `📋 Reload playlist HLS`);
        } else if (/cur_seq_no|skipping \d+ segments/.test(output)) {
          sendLog(process_id, 'info', `⚠️ Gap de segmentos detectado`);
        } else if (/Connection timed out|Operation timed out/.test(output) && !/frame=/.test(output)) {
          sendLog(process_id, 'info', `🌐 Jitter SOCKS5 (timeout transitorio)`);
        }
      }

      // 1) Clasificar primero causas reales (aunque no contengan "error/failed")
      const wasCategorized = detectAndCategorizeError(output, process_id);
      if (wasCategorized) return;
      
      // Detectar diferentes tipos de mensajes
      if (output.includes('frame=') || output.includes('fps=')) {
        // Progreso normal — actualizar watchdog
        lastFrameTime.set(process_id, Date.now());
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          sendLog(process_id, 'success', `Emisión iniciada exitosamente`);
          
          // Actualizar base de datos a estado 'running'
          if (supabase) {
            supabase
              .from('emission_processes')
              .update({
                emit_status: 'running',
                is_active: true,
                is_emitting: true,
                source_url: effectiveSourceM3u8,
                updated_at: new Date().toISOString()
              })
              .eq('id', parseInt(process_id))
              .then(() => {})
              .catch(err => console.error('Error actualizando estado a running:', err));
          }
        }
        
        // Extraer estadísticas básicas del progreso (throttled a cada 10s)
        const frameMatch = output.match(/frame=\s*(\d+)/);
        const fpsMatch = output.match(/fps=\s*([\d.]+)/);
        const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
        
        if (frameMatch && fpsMatch) {
          const now = Date.now();
          const lastLog = lastProgressLog.get(process_id) || 0;
          if (now - lastLog >= PROGRESS_LOG_INTERVAL) {
            lastProgressLog.set(process_id, now);
            sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}, bitrate=${bitrateMatch ? bitrateMatch[1] + 'kbps' : 'N/A'}`);
          }
        }
      } else if (
        output.includes('not enough frames to estimate rate') ||
        output.includes('Could not find codec parameters') ||
        output.includes('consider increasing the value for the')
      ) {
        sendLog(process_id, 'warn', `FFmpeg warning: ${output.trim()}`);
      } else if (
        output.includes('error') || output.includes('Error') ||
        output.includes('failed') || output.includes('Failed') ||
        output.includes('Connection reset by peer') ||
        output.includes('Broken pipe')
      ) {
        const isStoppingNow =
          emissionStatuses.get(process_id) === 'stopping' ||
          manualStopProcesses.has(process_id) ||
          manualStopProcesses.has(String(process_id)) ||
          manualStopProcesses.has(Number(process_id));

        // Filtrar ruido de FFmpeg que NO son errores reales:
        // - cierre manual (SIGTERM) mientras FFmpeg todavía parsea HLS
        // - estadísticas finales del encoder
        const isNoise =
          /\[libx264 @/.test(output) ||
          /\[aac @/.test(output) ||
          /\[h264 @/.test(output) ||
          output.includes("Skip ('#EXT-X-") ||
          output.includes('keepalive request failed') ||
          output.includes('Error in the pull function') ||
          output.includes('failed to delete old segment') ||
          output.includes('retrying with new connection') ||
          (isStoppingNow && output.includes('Error when loading first segment')) ||
          (isStoppingNow && output.includes('Immediate exit requested')) ||
          (isStoppingNow && output.includes('Output file #0 does not contain any stream')) ||
          (isStoppingNow && output.includes('received signal 15'));
        if (isNoise) {
          return;
        }

        sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
      } else if (output.includes('warning') || output.includes('Warning')) {
        // Advertencia
        sendLog(process_id, 'warn', `FFmpeg warning: ${output.trim()}`);
      } else {
        // Información general (solo las líneas importantes)
        if (output.includes('Stream #') || output.includes('Input #') || output.includes('Output #')) {
          sendLog(process_id, 'info', `FFmpeg: ${output.trim()}`);
        }
      }
    });

    // Manejar cierre del proceso
    ffmpegProcess.on('close', async (code, signal) => {
      // Detener keep-alive de Tigo (si estaba activo) — evita fugas de timers
      stopTigoKeepAlive(process_id);
      // Si Tigo BUFFER estaba activo, matar también la ETAPA 2 (transcoder local)
      stopTigoOutputStage(process_id);
      // Resetear métricas SRT (modo HDMI)
      if (String(process_id) === '12') resetTigoSrtMetric(process_id);
      const processInfo = ffmpegProcesses.get(process_id);
      const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
      const statusAtClose = emissionStatuses.get(process_id);
      const isManualStop =
        statusAtClose === 'stopping' ||
        manualStopProcesses.has(process_id) ||
        manualStopProcesses.has(String(process_id)) ||
        manualStopProcesses.has(Number(process_id));

      // Snapshot forense: guardar últimas 100 líneas de log a Supabase
      const snapshotReason = isManualStop
        ? `Stop manual (code=${code}${signal ? `, signal=${signal}` : ''}, runtime=${Math.floor(runtime/1000)}s)`
        : `Cierre inesperado (code=${code}${signal ? `, signal=${signal}` : ''}, runtime=${Math.floor(runtime/1000)}s)`;
      saveLogSnapshot(process_id, snapshotReason).catch(()=>{});

      const rawDiagnosticLines = stderrBuffer
        .filter(l => !l.includes('frame=') && !l.includes('fps='))
        .slice(-8);

      const diagnosticLines = rawDiagnosticLines
        .filter(l =>
          !/\[libx264 @/.test(l) &&
          !/\[aac @/.test(l) &&
          !/\[h264 @/.test(l) &&
          !l.includes('Conversion failed') &&
          !l.includes('Immediate exit requested') &&
          !l.includes('Output file #0 does not contain any stream') &&
          !l.includes('Exiting normally, received signal 15')
        )
        .slice(-8);

      const finalStatus = isManualStop ? 'stopped' : (code === 0 ? 'stopped' : 'error');
      const signalInfo = signal ? `, signal: ${signal}` : '';
      const logMessage = isManualStop
        ? `FFmpeg detenido manualmente (runtime: ${Math.floor(runtime / 1000)}s${signalInfo})`
        : code === 0
          ? `FFmpeg terminó exitosamente (código: ${code}, runtime: ${Math.floor(runtime / 1000)}s${signalInfo})`
          : `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime / 1000)}s${signalInfo})`;

      if (isManualStop || code === 0) {
        sendLog(process_id, 'success', logMessage);
      } else if (diagnosticLines.length > 0) {
        sendLog(process_id, 'error', logMessage);
        sendLog(process_id, 'error', `📋 Últimas líneas de FFmpeg:\n${diagnosticLines.join('\n')}`);
        sendFailureNotification(process_id, 'server', `Proceso terminado con código de error ${code}`);
      } else if (rawDiagnosticLines.length > 0) {
        // Si no hay diagnóstico "limpio", mostrar crudo para no ocultar la causa real
        sendLog(process_id, 'error', logMessage);
        sendLog(process_id, 'error', `📋 Diagnóstico crudo FFmpeg:\n${rawDiagnosticLines.join('\n')}`);
        sendFailureNotification(process_id, 'server', `Proceso terminado con código de error ${code}`);
      } else {
        sendLog(process_id, 'error', `${logMessage} (sin salida de diagnóstico)`);
      }
      
      // Actualizar base de datos (solo si Supabase está disponible)
      const runtimeSeconds = Math.floor(runtime / 1000);
      if (supabase) {
        const diagSource = diagnosticLines.length > 0 ? diagnosticLines : rawDiagnosticLines;
        const diagInfo = !isManualStop && code !== 0 && diagSource.length > 0
          ? `\n[DIAGNÓSTICO] ${diagSource.slice(-5).join(' | ')}`
          : '';
        
        // Recuperar el error detectado durante stderr parsing
        const detectedError = detectedErrors.get(process_id);
        detectedErrors.delete(process_id);
        
        // Log de la URL que estaba en uso al momento de la caída
        const procAtClose = processInfo || {};
        const urlAtFailure = procAtClose.source_m3u8 || source_m3u8 || 'desconocida';
        if (!isManualStop && code !== 0) {
          sendLog(process_id, 'warn', `📎 URL al momento de caída: ${urlAtFailure.substring(0, 120)}`);
        }

        const updateData = {
          is_active: false,
          is_emitting: false,
          emit_status: finalStatus,
          ended_at: new Date().toISOString(),
          process_logs: `[${new Date().toISOString()}] ${logMessage}${diagInfo}\n`,
          elapsed: runtimeSeconds,
          start_time: 0,
          ffmpeg_pid: null,
        };

        if (isManualStop) {
          updateData.failure_reason = null;
          updateData.failure_details = null;
        }
        
        // Guardar failure_reason y failure_details si hubo error (no manual)
        if (!isManualStop) {
          if (detectedError) {
            updateData.failure_reason = detectedError.type;
            updateData.failure_details = detectedError.reason;
          } else if (code !== 0 && code !== null) {
            updateData.failure_reason = 'unknown';
            updateData.failure_details = diagSource.length > 0 
              ? `Exit code ${code}: ${diagSource.slice(-3).join(' | ')}` 
              : `Exit code ${code} sin diagnóstico (posible crash silencioso o kill del sistema)`;
          } else if (code === 0) {
            updateData.failure_reason = 'eof';
            updateData.failure_details = 'FFmpeg salió con código 0 (fuente expirada, EOF, o CDN cortó)';
          }
        }
        
        // Guardar duración de la última señal antes de reiniciar (solo si no es parada manual)
        if (!isManualStop && runtimeSeconds > 0) {
          updateData.last_signal_duration = runtimeSeconds;
          sendLog(process_id, 'info', `⏱️ Última señal duró: ${Math.floor(runtimeSeconds / 3600)}h ${Math.floor((runtimeSeconds % 3600) / 60)}m ${runtimeSeconds % 60}s`);
        }
        
        await supabase
          .from('emission_processes')
          .update(updateData)
          .eq('id', parseInt(process_id))
          .eq('ffmpeg_pid', processInfo?.process?.pid || ffmpegProcess.pid);
      }
      
      emissionStatuses.set(process_id, 'idle');
      ffmpegProcesses.delete(process_id);
      // Cerrar mini-proxy de Tigo si existe (Fase 2)
      stopTigoProxy(process_id).catch(() => {});

      lastFrameTime.delete(process_id); // Limpiar watchdog
      
      // AUTO-RECOVERY: Para canales con scraping (usa CHANNEL_MAP global)

      if (isManualStop) {
        sendLog(process_id, 'info', '🛑 Parada manual detectada - Auto-recovery desactivado');
        manualStopProcesses.delete(process_id);
        manualStopProcesses.delete(String(process_id));
        manualStopProcesses.delete(Number(process_id));
        quickRetryState.delete(process_id);
      } else if (code !== null || signal) {
        // Auto-recovery para CUALQUIER cierre no manual (código de salida o señal como SIGKILL del watchdog)
        const isCleanExit = code === 0;
        if (isCleanExit) {
          sendLog(process_id, 'warn', `⚠️ FFmpeg salió con código 0 (fuente expirada o EOF) - Intentando auto-recovery...`);
        }

        // === CIRCUIT BREAKER: registrar fallo y verificar si estamos en tormenta ===
        recordFailure(process_id);
        if (isCircuitBroken(process_id)) {
          sendLog(process_id, 'error', `🔴 CIRCUIT BREAKER: ${CIRCUIT_BREAKER_MAX_FAILURES}+ caídas en ${CIRCUIT_BREAKER_WINDOW_MS / 60000} min. Recovery DETENIDO para evitar saturación del servidor.`);
          if (supabase) {
            await supabase.from('emission_processes').update({
              is_active: false, is_emitting: false, emit_status: 'error',
              failure_reason: 'circuit_breaker',
              failure_details: `Demasiadas caídas consecutivas (${CIRCUIT_BREAKER_MAX_FAILURES} en ${CIRCUIT_BREAKER_WINDOW_MS / 60000} min). Reiniciar manualmente.`
            }).eq('id', parseInt(process_id));
          }
          // No hacer recovery, dejar el proceso muerto
        } else {
        
        // MEJORA #2: Retry con misma URL antes de recovery completo
        // Para canales scrapeados (1-6, 8, 9), intentar primero con la misma URL
        // ya que muchas caídas son micro-cortes del CDN donde la URL sigue válida
        const shouldRetryFirst = !!CHANNEL_MAP[process_id];
        const lastQuickRetryAt = quickRetryState.get(process_id) || 0;
        const quickRetryRecentlyFailed = lastQuickRetryAt > 0 && (Date.now() - lastQuickRetryAt) < 30000;

        // Si duró estable suficiente tiempo, permitimos nuevamente retry rápido en futuras caídas.
        if (runtime > 30000 && lastQuickRetryAt > 0) {
          quickRetryState.delete(process_id);
        }

        if (shouldRetryFirst && runtime > 10000 && quickRetryRecentlyFailed) {
          sendLog(process_id, 'warn', '⚠️ RETRY RÁPIDO omitido: caída repetida tras retry reciente, iniciando recovery completo...');
        }
        
        if (shouldRetryFirst && runtime > 10000 && !quickRetryRecentlyFailed) {
          // Solo retry si el proceso corrió más de 10s (evitar loops en URLs inválidas)
          // Para Tigo (proxy): delay 5s para que Wowza limpie el nimblesessionid de la
          // sesión anterior. Sin esto, el master playlist devuelve sub-playlists con el
          // nimblesessionid viejo invalidado → 403 inmediato en todos los segmentos
          // (sesiones de ~30-40s post-recovery observadas en producción).
          const isTigoProxy = PROXY_PROCESSES.has(String(process_id));
          const retryDelayMs = isTigoProxy ? 5000 : 500;
          if (isTigoProxy) {
            sendLog(process_id, 'info', `🔁 RETRY RÁPIDO Tigo: esperando ${retryDelayMs/1000}s para que Wowza libere nimblesessionid anterior...`);
          } else {
            sendLog(process_id, 'info', `🔁 RETRY RÁPIDO: Intentando reiniciar con misma URL antes de recovery completo...`);
          }

          setTimeout(async () => {
            try {
              const rememberedState = getRememberedStreamState(process_id);
              let retrySourceUrl = rememberedState?.source_m3u8 || '';
              let retryTargetRtmp = rememberedState?.target_rtmp || '';

              // Verificar si el usuario detuvo manualmente mientras esperábamos
              if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
                sendLog(process_id, 'info', `🛑 Retry rápido cancelado: parada manual detectada durante espera`);
                manualStopProcesses.delete(String(process_id));
                manualStopProcesses.delete(Number(process_id));
                return;
              }

              if (supabase) {
                const { data: procData, error: procError } = await supabase
                  .from('emission_processes')
                  .select('m3u8, rtmp')
                  .eq('id', parseInt(process_id))
                  .single();

                if (procError) {
                  sendLog(process_id, 'warn', `⚠️ RETRY: lectura de base falló (${procError.message}), usando memoria local si existe...`);
                }

                retrySourceUrl = procData?.m3u8 || retrySourceUrl;
                retryTargetRtmp = procData?.rtmp || retryTargetRtmp;
              } else if (retrySourceUrl && retryTargetRtmp) {
                sendLog(process_id, 'warn', '⚠️ RETRY: Base no disponible, usando última configuración en memoria');
              }
              
              if (retrySourceUrl && retryTargetRtmp) {
                // Para procesos con proxy (Tigo): re-scrapear URL vía Pi5 antes de reintentar,
                // porque el token wmsAuthSign expira en 60s y la URL vieja ya está muerta.
                if (PROXY_PROCESSES.has(String(process_id)) && CHANNEL_MAP[String(process_id)]) {
                  // En modo HDMI (Tigo), la URL es siempre srt://pi5-hdmi:9000 y el Pi5
                  // empuja el stream 24/7. NO debemos re-scrapear ni reemplazar la URL,
                  // porque eso volvería al flujo legacy de scraping con tokens y rompería
                  // la ingesta SRT.
                  const isTigoHdmi = String(process_id) === '12' && TIGO_USE_HDMI;
                  if (isTigoHdmi) {
                    sendLog(process_id, 'info', '📡 RETRY HDMI: manteniendo srt://pi5-hdmi:9000 (sin re-scrape)');
                  } else {
                    const { channelId, channelName } = CHANNEL_MAP[String(process_id)];
                    sendLog(process_id, 'info', `🔄 RETRY: refrescando URL via Pi5 (token expirado)...`);
                    const fresh = await scrapeStreamUrlLocal(channelId, channelName, { useProxy: true });
                    if (fresh.url) {
                      // Cache-buster: forzar a Wowza/Nimble a tratar el master playlist como
                      // request fresco y NO reutilizar el nimblesessionid de la sesión anterior
                      // (que quedó invalidado al expirar el token original). Sin esto, los
                      // sub-playlists (chunks.m3u8) heredan el sessionid muerto → 403 inmediato.
                      const sep = fresh.url.includes('?') ? '&' : '?';
                      retrySourceUrl = `${fresh.url}${sep}_t=${Date.now()}`;
                      scrapeSessionCache.set(String(process_id), {
                        cookies: fresh.cookies || null,
                        accessToken: fresh.accessToken || null,
                        timestamp: Date.now(),
                      });
                      sendLog(process_id, 'success', `✅ RETRY: URL fresca obtenida via Pi5 (con cache-buster anti nimblesessionid)`);
                    } else {
                      sendLog(process_id, 'warn', `⚠️ RETRY: scraping via Pi5 falló (${fresh.error || 'sin URL'}), usando URL guardada`);
                    }
                  }
                }
                rememberStreamState(process_id, { source_m3u8: retrySourceUrl, target_rtmp: retryTargetRtmp });
                // Reiniciar con misma URL (o fresca si es proxy)
                const emitUrl = `http://localhost:${PORT}/api/emit`;
                const emitResp = await fetch(emitUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: retrySourceUrl,
                    target_rtmp: retryTargetRtmp,
                    process_id: process_id,
                    is_recovery: true
                  })
                });
                
                if (emitResp.ok) {
                  quickRetryState.set(process_id, Date.now());
                  sendLog(process_id, 'success', `✅ RETRY RÁPIDO: Reiniciado con misma URL exitosamente`);
                  // Incrementar recovery_count en DB para contabilizar este retry
                  if (supabase) {
                    const { error: rpcErr } = await supabase.rpc('increment_recovery_count', { process_id: parseInt(process_id) });
                    if (rpcErr) {
                      console.error('Error incrementando recovery_count en retry rápido:', rpcErr.message);
                      // Fallback directo
                      const { data: row } = await supabase.from('emission_processes').select('recovery_count').eq('id', parseInt(process_id)).single();
                      await supabase.from('emission_processes').update({ recovery_count: (row?.recovery_count || 0) + 1 }).eq('id', parseInt(process_id));
                    }
                  }
                  // Monitorear: si cae de nuevo rápido (<15s), la próxima vez va directo a recovery
                } else {
                  const errText = await emitResp.text().catch(() => '');
                  sendLog(process_id, 'warn', `⚠️ RETRY RÁPIDO falló (${emitResp.status}${errText ? `: ${errText.substring(0, 120)}` : ''}), iniciando recovery completo...`);
                  if (CHANNEL_MAP[process_id]) {
                    const { channelId, channelName } = CHANNEL_MAP[process_id];
                    await autoRecoverChannel(process_id, channelId, channelName);
                  }
                }
              } else {
                sendLog(process_id, 'warn', `⚠️ RETRY: No hay URL/RTMP guardados ni en base ni en memoria, saltando a recovery completo`);
                if (CHANNEL_MAP[process_id]) {
                  const { channelId, channelName } = CHANNEL_MAP[process_id];
                  await autoRecoverChannel(process_id, channelId, channelName);
                }
              }
            } catch (retryErr) {
              sendLog(process_id, 'error', `❌ RETRY error: ${retryErr.message}, iniciando recovery completo...`);
              if (CHANNEL_MAP[process_id]) {
                const { channelId, channelName } = CHANNEL_MAP[process_id];
                await autoRecoverChannel(process_id, channelId, channelName);
              }
            }
          }, retryDelayMs);
        } else if (CHANNEL_MAP[process_id]) {
          // Recovery completo directo (proceso corrió <10s = URL probablemente inválida)
          const { channelId, channelName } = CHANNEL_MAP[process_id];
          if (runtime <= 10000) {
            sendLog(process_id, 'warn', `🔄 ${channelName} caído rápido (${Math.floor(runtime/1000)}s) - URL inválida, recovery completo directo...`);
          } else {
            sendLog(process_id, 'warn', `🔄 ${channelName} caído (código ${code}) - Iniciando recovery completo...`);
          }
          enqueueRecovery(process_id, async () => {
            await sleep(500);
            // Verificar si el usuario detuvo manualmente mientras esperábamos
            if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
              sendLog(process_id, 'info', `🛑 Recovery cancelado: parada manual detectada durante espera`);
              manualStopProcesses.delete(String(process_id));
              manualStopProcesses.delete(Number(process_id));
              return;
            }
            await autoRecoverChannel(process_id, channelId, channelName);
          });
        } else if (MANUAL_URL_PROCESSES.has(String(process_id)) || AUTO_INGEST_PROCESSES.has(String(process_id))) {
          // Procesos manuales (Disney 7, Disney 8, Canal 6): reutilizar la misma URL M3U8 guardada en DB
          const procId = parseInt(String(process_id), 10);
          const manualLabels = { '0': 'Disney 7', '5': 'Canal 6', '10': 'Disney 8', '12': 'TIGO SRT', '15': 'CANAL 6 URL' };
          const procLabel = manualLabels[String(process_id)] || 'Manual';
          
          const failureType = detectedErrors.get(process_id);
          const failureInfo = failureType ? ` (${failureType.reason || failureType.type})` : '';
          
          // Disney 7 (TUDN): recovery DIRECTO sin pre-checks (fuente super estable)
          // Canal 6 y Disney 8: mantienen pre-check con failover
          const isDirectRecovery = String(process_id) === '0' || AUTO_INGEST_PROCESSES.has(String(process_id));
          
          if (isDirectRecovery) {
            sendLog(process_id, 'warn', `🔄 ${procLabel} caído (código ${code})${failureInfo} - Recovery directo...`);
          } else {
            sendLog(process_id, 'warn', `🔄 ${procLabel} caído (código ${code})${failureInfo} - Iniciando recovery con pre-check...`);
          }
          
          // Esperar 3s inicial para liberar socket RTMP
          enqueueRecovery(process_id, async () => {
            await sleep(3000);
            try {
              if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
                sendLog(procId, 'info', `🛑 Recovery cancelado: parada manual detectada`);
                manualStopProcesses.delete(String(process_id));
                manualStopProcesses.delete(Number(process_id));
                return;
              }
              if (!supabase) {
                sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel}: Base de datos no disponible`);
                return;
              }
              
              const { data: procData } = await supabase
                .from('emission_processes')
                .select('m3u8, rtmp')
                .eq('id', procId)
                .single();
              
              const sourceUrl = procData?.m3u8;
               const targetRtmp = procData?.rtmp;
               const effectiveTarget = HLS_OUTPUT_PROCESSES.has(String(process_id))
                 ? 'hls-local'
                 : (targetRtmp || '');

              if (!sourceUrl || !effectiveTarget) {
                sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel}: No hay M3U8 o destino guardados`);
                return;
              }
              
              autoRecoveryInProgress.set(String(process_id), true);
              let finalUrl = sourceUrl;
              
              if (isDirectRecovery) {
                // ── DISNEY 7: RECOVERY DIRECTO ──
                // TUDN es super estable, no necesita health checks, solo relanzar
                sendLog(procId, 'info', `🚀 ${procLabel}: Relanzando inmediatamente con misma URL...`);
              } else {
                 // ── CANAL 6 / DISNEY 8: PRE-FLIGHT HEALTH CHECK CON FAILOVER ──
                const HEALTH_CHECK_INTERVAL = 5000;
                const HEALTH_CHECK_MAX_ATTEMPTS = 4;
                
                await supabase.from('emission_processes').update({
                  emit_status: 'waiting_cdn', is_active: true, is_emitting: false
                }).eq('id', procId);
                
                const checkUrlHealth = async (url, label) => {
                  sendLog(procId, 'info', `⏳ ${procLabel}: Verificando ${label}...`);
                  for (let attempt = 1; attempt <= HEALTH_CHECK_MAX_ATTEMPTS; attempt++) {
                    if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
                      return { ready: false, cancelled: true };
                    }
                    try {
                      const controller = new AbortController();
                      const timeout = setTimeout(() => controller.abort(), 8000);
                      const resp = await fetch(url, {
                        method: 'GET',
                        signal: controller.signal,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
                      });
                      clearTimeout(timeout);
                      if (resp.ok) {
                        sendLog(procId, 'success', `✅ ${procLabel}: ${label} respondió HTTP ${resp.status}`);
                        return { ready: true, cancelled: false };
                      }
                      sendLog(procId, 'warn', `⏳ ${procLabel}: ${label} HTTP ${resp.status} (${attempt}/${HEALTH_CHECK_MAX_ATTEMPTS})`);
                    } catch (fetchErr) {
                      const errMsg = fetchErr.name === 'AbortError' ? 'timeout' : fetchErr.message;
                      sendLog(procId, 'warn', `⏳ ${procLabel}: ${label} - ${errMsg} (${attempt}/${HEALTH_CHECK_MAX_ATTEMPTS})`);
                    }
                    if (attempt < HEALTH_CHECK_MAX_ATTEMPTS) {
                      await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL));
                    }
                  }
                  return { ready: false, cancelled: false };
                };
                
                let primaryResult = await checkUrlHealth(sourceUrl, 'URL principal');
                
                if (primaryResult.cancelled) {
                  sendLog(procId, 'info', `🛑 Recovery cancelado: parada manual durante health-check`);
                  manualStopProcesses.delete(String(process_id));
                  manualStopProcesses.delete(Number(process_id));
                  autoRecoveryInProgress.set(String(process_id), false);
                  return;
                }
                
                if (!primaryResult.ready) {
                  sendLog(procId, 'error', `❌ ${procLabel}: CDN no respondió. Recovery detenido.`);
                  autoRecoveryInProgress.set(String(process_id), false);
                  await supabase.from('emission_processes').update({
                    is_active: false, is_emitting: false, emit_status: 'error',
                    ended_at: new Date().toISOString(),
                    failure_reason: 'cdn_unavailable',
                    failure_details: `CDN no respondió tras ${HEALTH_CHECK_MAX_ATTEMPTS * HEALTH_CHECK_INTERVAL / 1000}s de polling`
                  }).eq('id', procId);
                  return;
                }
              }
              
              // Verificar parada manual una última vez
              if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
                sendLog(procId, 'info', `🛑 Recovery cancelado: parada manual justo antes de lanzar FFmpeg`);
                manualStopProcesses.delete(String(process_id));
                manualStopProcesses.delete(Number(process_id));
                autoRecoveryInProgress.set(String(process_id), false);
                return;
              }
              
              // === LANZAR FFMPEG ===
              await supabase.from('emission_processes').update({
                emit_status: 'starting', is_emitting: true, is_active: true
              }).eq('id', procId);
              
              const emitResp = await fetch(`http://localhost:${PORT}/api/emit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source_m3u8: finalUrl,
                  target_rtmp: effectiveTarget,
                  process_id: String(process_id),
                  is_recovery: true
                })
              });
              
              if (emitResp.ok) {
                sendLog(procId, 'success', `✅ AUTO-RECOVERY ${procLabel} completado: Emisión reiniciada${finalUrl !== sourceUrl ? ' (con URL respaldo)' : ''}`);
                if (supabase) {
                  const { error: rpcErr } = await supabase.rpc('increment_recovery_count', { process_id: procId });
                  if (rpcErr) {
                    const { data: row } = await supabase.from('emission_processes').select('recovery_count').eq('id', procId).single();
                    await supabase.from('emission_processes').update({ recovery_count: (row?.recovery_count || 0) + 1 }).eq('id', procId);
                  }
                }
              } else {
                sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel} falló: ${emitResp.status}`);
              }
            } catch (err) {
              sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel} error: ${err.message}`);
            } finally {
              autoRecoveryInProgress.set(String(process_id), false);
            }
          });
        } else if (String(process_id) === '12') {
          sendLog(process_id, 'info', '🛑 TIGO SRT quedó detenido: usa Emitir cuando OBS vuelva a enviar señal.');
          if (supabase) {
            await supabase.from('emission_processes').update({
              is_active: false,
              is_emitting: false,
              emit_status: 'idle',
              failure_reason: null,
              failure_details: null,
            }).eq('id', parseInt(process_id));
          }
        }
        } // end circuit breaker else
      }
    });

    // Manejar error del proceso
    ffmpegProcess.on('error', async (error) => {
      sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`, { error: error.toString() });
      sendFailureNotification(process_id, 'server', `Error crítico del servidor: ${error.message}`);
      
      // Actualizar base de datos (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'error',
            ended_at: new Date().toISOString(),
            failure_reason: 'server',
            failure_details: error.message,
            process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`,
            start_time: 0,
            elapsed: 0,
            ffmpeg_pid: null,
          })
          .eq('id', parseInt(process_id))
          .eq('ffmpeg_pid', ffmpegProcess.pid);
      }
      
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
      lastFrameTime.delete(process_id);
    });

    // NOTA: No forzar 'running' por timeout — el watchdog y el parser de stderr
    // se encargan de detectar el primer frame y cambiar el estado correctamente.

    res.json({ 
      success: true, 
      message: 'Emisión iniciada correctamente',
      status: 'starting',
      start_time: dbRecord?.start_time || Math.floor(Date.now() / 1000)
    });

  } catch (error) {
    console.error(`❌ Error en /api/emit [${req.body.process_id || '0'}]:`, error);
    emissionStatuses.set(req.body.process_id || '0', 'error');
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Endpoint para emitir archivos locales
app.post('/api/emit/files', upload.array('files', 10), async (req, res) => {
  try {
    const { target_rtmp, process_id = '3' } = req.body;
    const files = req.files;

    sendLog(process_id, 'info', `Nueva solicitud de emisión con archivos`, { 
      fileCount: files?.length || 0, 
      target_rtmp 
    });

    // Validaciones
    if (!files || files.length === 0) {
      sendLog(process_id, 'error', 'No se recibieron archivos');
      return res.status(400).json({ 
        error: 'No se recibieron archivos' 
      });
    }

    if (!target_rtmp) {
      sendLog(process_id, 'error', 'Falta parámetro target_rtmp');
      return res.status(400).json({ 
        error: 'Falta parámetro target_rtmp' 
      });
    }

    // VALIDACIÓN CRÍTICA: Verificar conflicto de destino RTMP
    const conflictingProcessId = checkRTMPConflict(target_rtmp, process_id);
    if (conflictingProcessId) {
      const conflictingProcess = ffmpegProcesses.get(conflictingProcessId);
      sendLog(process_id, 'error', `⚠️ CONFLICTO: El destino RTMP ya está en uso por Proceso ${conflictingProcessId}`);
      sendLog(conflictingProcessId, 'warn', `⚠️ Otro proceso (${process_id}) intenta usar el mismo destino RTMP - deteniendo este proceso`);
      
      // Detener el proceso conflictivo
      if (conflictingProcess && conflictingProcess.process && !conflictingProcess.process.killed) {
        manualStopProcesses.add(String(conflictingProcessId));
        manualStopProcesses.add(Number(conflictingProcessId));
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      manualStopProcesses.add(String(process_id));
      manualStopProcesses.add(Number(process_id));
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
      
      // Actualizar el registro anterior como finalizado (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({ 
            is_active: false, 
            is_emitting: false, 
            ended_at: new Date().toISOString(),
            emit_status: 'stopped',
            start_time: 0,
            elapsed: 0,
            ffmpeg_pid: null,
          })
          .eq('id', parseInt(process_id))
          .eq('ffmpeg_pid', existingProcess.process.pid)
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos
    const fileNames = files.map(f => f.originalname).join(', ');
    
    if (!supabase) {
      sendLog(process_id, 'warn', 'Supabase no configurado: no se guardará el proceso en base de datos.');
    }
    
    const dbRecord = supabase ? (await supabase
      .from('emission_processes')
      .update({
        id: parseInt(process_id),
        m3u8: `Archivos: ${fileNames}`,
        rtmp: target_rtmp,
        is_active: true,
        is_emitting: true,
        emit_status: 'starting',
        start_time: Math.floor(Date.now() / 1000), // Guardar en segundos
        process_logs: `[${new Date().toISOString()}] Iniciando emisión desde archivos locales: ${fileNames}\n`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', parseInt(process_id))
      .select()
      .single()).data : null;
    
    if (supabase && dbRecord) {
      sendLog(process_id, 'info', `✅ Proceso guardado en base de datos (ID: ${process_id})`);
    }
    
    // Si hay múltiples archivos, crear un archivo concat
    let inputSource;
    let cleanupFiles = [];
    
    if (files.length === 1) {
      inputSource = files[0].path;
      sendLog(process_id, 'info', `Emitiendo archivo único: ${files[0].originalname}`);
    } else {
      // Crear archivo concat para múltiples videos usando rutas relativas
      const concatFilePath = path.join(__dirname, 'uploads', `concat-${process_id}-${Date.now()}.txt`);
      const concatContent = files.map(f => `file '${path.basename(f.path)}'`).join('\n');
      fs.writeFileSync(concatFilePath, concatContent);
      inputSource = path.basename(concatFilePath);
      cleanupFiles.push(concatFilePath);
      sendLog(process_id, 'info', `Creada playlist con ${files.length} archivos`);
    }

    // Subida: detectar bitrate — copy si ≤5000kbps, re-encode 720p si >5000kbps
    const firstFile = files[0].path;
    sendLog(process_id, 'info', '🔍 Subida: Detectando resolución y bitrate del archivo...');
    const { width: srcW, height: srcH, bitrateKbps: srcBitrate } = await detectSourceInfo(firstFile);
    sendLog(process_id, 'info', `📐 Fuente: ${srcW}x${srcH} @ ${srcBitrate}kbps`);
    
    let videoParams, audioParams;
    
    if (srcBitrate > 0 && srcBitrate <= 5000) {
      // ≤5000kbps: stream copy
      sendLog(process_id, 'info', `✅ Subida: ${srcBitrate}kbps ≤ 5000 → COPY (sin re-encodear)`);
      videoParams = ['-c:v', 'copy'];
      audioParams = ['-c:a', 'copy'];
    } else {
      // >5000kbps o no detectado: re-encodear con perfil unificado CBR 2000k
      sendLog(process_id, 'info', `📺 Subida: ${srcBitrate || '?'}kbps > 5000 → Re-encode CBR 2000k 720p30 (perfil unificado)`);
      videoParams = [
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
        '-threads', '4',
        '-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '4000k',
        '-vf', 'scale=-2:720',
        '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'
      ];
      audioParams = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
    }
    
    let ffmpegArgs;
    
    if (files.length === 1) {
      ffmpegArgs = [
        '-re', '-stream_loop', '-1',
        '-i', path.basename(inputSource),
        ...videoParams,
        ...audioParams,
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp
      ];
    } else {
      ffmpegArgs = [
        '-re', '-f', 'concat', '-safe', '0', '-stream_loop', '-1',
        '-i', inputSource,
        ...videoParams,
        ...audioParams,
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp
      ];
    }

    const commandStr = 'ffmpeg ' + ffmpegArgs.join(' ');
    sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 150)}...`);

    // Ejecutar ffmpeg
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      cwd: path.join(__dirname, 'uploads')
    });
    
    const processInfo = { 
      process: ffmpegProcess, 
      status: 'starting',
      startTime: Date.now(),
      target_rtmp: target_rtmp,
      cleanupFiles: cleanupFiles.concat(files.map(f => f.path))
    };
    ffmpegProcesses.set(process_id, processInfo);

    if (supabase) {
      await supabase
        .from('emission_processes')
        .update({
          ffmpeg_pid: ffmpegProcess.pid,
          start_time: dbRecord?.start_time || Math.floor(Date.now() / 1000),
          ended_at: null,
        })
        .eq('id', parseInt(process_id));
    }

    // Manejar salida (reutilizar lógica existente)
    ffmpegProcess.stdout.on('data', (data) => {
      const output = data.toString();
      sendLog(process_id, 'info', `FFmpeg stdout: ${output.trim()}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('frame=') || output.includes('fps=')) {
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          sendLog(process_id, 'success', `Emisión de archivos iniciada exitosamente`);
        }
        
        const frameMatch = output.match(/frame=\s*(\d+)/);
        const fpsMatch = output.match(/fps=\s*([\d.]+)/);
        if (frameMatch && fpsMatch) {
          const now = Date.now();
          const lastLog = lastProgressLog.get(process_id) || 0;
          if (now - lastLog >= PROGRESS_LOG_INTERVAL) {
            lastProgressLog.set(process_id, now);
            sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}`);
          }
        }
      } else if (output.includes('error') || output.includes('Error') || output.includes('failed') || output.includes('Failed')) {
        const isNoise =
          output.includes('Conversion failed') ||
          /\[libx264 @/.test(output) ||
          /\[aac @/.test(output) ||
          /\[h264 @/.test(output) ||
          output.includes('keepalive request failed') ||
          output.includes('Error in the pull function') ||
          output.includes('retrying with new connection');
        if (isNoise) return;
        const wasHandled = detectAndCategorizeError(output, process_id);
        if (!wasHandled) {
          sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
        }
      }
    });

    ffmpegProcess.on('close', async (code) => {
      const processInfo = ffmpegProcesses.get(process_id);
      const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
      
      // Limpiar archivos siempre
      if (processInfo && processInfo.cleanupFiles) {
        processInfo.cleanupFiles.forEach(file => {
          try {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file);
              sendLog(process_id, 'info', `Archivo limpiado: ${path.basename(file)}`);
            }
          } catch (e) {
            console.error(`Error limpiando archivo ${file}:`, e);
          }
        });
      }
      
      const finalStatus = code === 0 ? 'stopped' : 'error';
      const logMessage = code === 0
        ? `FFmpeg terminó exitosamente (runtime: ${Math.floor(runtime/1000)}s)`
        : `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`;
      
      if (code === 0) {
        sendLog(process_id, 'success', logMessage);
      } else {
        sendLog(process_id, 'error', logMessage);
        sendFailureNotification(process_id, 'server', `Proceso de archivos terminado con código de error ${code}`);
      }

      // Snapshot forense: guardar últimas 100 líneas de log a Supabase
      saveLogSnapshot(
        process_id,
        code === 0
          ? `Cierre exitoso (code=0, runtime=${Math.floor(runtime/1000)}s)`
          : `Cierre con error (code=${code}, runtime=${Math.floor(runtime/1000)}s)`
      ).catch(()=>{});
      
      // Actualizar base de datos (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: finalStatus,
            ended_at: new Date().toISOString(),
            process_logs: `[${new Date().toISOString()}] ${logMessage}\n`,
            elapsed: Math.floor(runtime / 1000),
            start_time: 0,
            ffmpeg_pid: null,
          })
          .eq('id', parseInt(process_id))
          .eq('ffmpeg_pid', processInfo?.process?.pid || ffmpegProcess.pid);
      }
      
      emissionStatuses.set(process_id, 'idle');
      ffmpegProcesses.delete(process_id);
    });

    ffmpegProcess.on('error', async (error) => {
      sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`);
      sendFailureNotification(process_id, 'server', `Error crítico del servidor: ${error.message}`);
      
      // Actualizar base de datos (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'error',
            ended_at: new Date().toISOString(),
            failure_reason: 'server',
            failure_details: error.message,
            process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`,
            start_time: 0,
            elapsed: 0,
            ffmpeg_pid: null,
          })
          .eq('id', parseInt(process_id))
          .eq('ffmpeg_pid', ffmpegProcess.pid);
      }
      
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
    });

    // NOTA: No forzar 'running' por timeout — el parser de stderr detecta el primer frame.

    res.json({ 
      success: true, 
      message: `Emisión iniciada con ${files.length} archivo(s)`,
      status: 'starting',
      start_time: dbRecord?.start_time || Math.floor(Date.now() / 1000),
      files: files.map(f => ({ name: f.originalname, size: f.size }))
    });

  } catch (error) {
    const process_id = req.body.process_id || '3';
    console.error(`❌ Error en /api/emit/files [${process_id}]:`, error);
    emissionStatuses.set(process_id, 'error');
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Endpoint para detener emisión
app.post('/api/emit/stop', async (req, res) => {
  try {
    const { process_id: rawProcessId = '0', internal_refresh = false } = req.body;
    const process_id = String(rawProcessId);
    const numericProcessId = parseInt(process_id);
    sendLog(process_id, 'info', internal_refresh ? `Detención interna (refresh 10h)` : `Solicitada detención de emisión`);

    // NOTA: NO tocamos always_on aquí. El switch "Encendido siempre" es
    // controlado EXCLUSIVAMENTE por el usuario desde el endpoint /api/always-on.
    // Apagarlo en cada stop causaba que el switch se reseteara solo tras
    // reinicios internos, retries o detenciones manuales (bug visible en UI).
    
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    let persistedPid = null;

    if (supabase && Number.isInteger(numericProcessId)) {
      const { data: persistedRow } = await supabase
        .from('emission_processes')
        .select('ffmpeg_pid, is_emitting')
        .eq('id', numericProcessId)
        .maybeSingle();

      if (persistedRow?.ffmpeg_pid && persistedRow.is_emitting) {
        persistedPid = persistedRow.ffmpeg_pid;
      }
    }

    if (processData && processData.process && !processData.process.killed) {
      emissionStatuses.set(process_id, 'stopping');
      manualStopProcesses.add(process_id); // Marcar como parada manual para evitar auto-recovery
      manualStopProcesses.add(Number(process_id));
      
      
      // Actualizar base de datos antes de detener (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'stopped',
            ended_at: new Date().toISOString(),
            start_time: 0,
            elapsed: 0,
            recovery_count: 0,
            last_signal_duration: 0,
            failure_reason: null,
            failure_details: null,
            process_logs: `[${new Date().toISOString()}] Emisión detenida manualmente\n`
          })
          .eq('id', numericProcessId);
      }
      
      // Guardar referencia antes de borrar del mapa
      const procRef = processData.process;
      
      // Intentar terminar graciosamente, luego esperar muerte real
      procRef.kill('SIGTERM');
      
      // Esperar hasta 5s a que muera. Si no, SIGKILL.
      await waitForProcessDeath(procRef, 3000);
      
      if (!procRef.killed) {
        sendLog(process_id, 'warn', `Forzando terminación de ffmpeg con SIGKILL`);
        procRef.kill('SIGKILL');
        await waitForProcessDeath(procRef, 2000);
      }
      
      // Último recurso: kill -9 por PID
      if (procRef.pid) {
        try {
          process.kill(procRef.pid, 0); // Verificar si sigue vivo
          sendLog(process_id, 'warn', `⚠️ Proceso PID ${procRef.pid} sigue vivo, matando con kill -9`);
          execSync(`kill -9 ${procRef.pid}`, { timeout: 2000 });
        } catch (e) {
          // El proceso ya murió, ok
        }
      }
      
      ffmpegProcesses.delete(process_id);
      // Cerrar mini-proxy de Tigo si existe (Fase 2)
      await stopTigoProxy(process_id);

      detectedErrors.delete(process_id);
      quickRetryState.delete(process_id);
      lastFrameTime.delete(process_id);
      lastProgressLog.delete(process_id);
      recoveryAttempts.delete(process_id);
      scrapeSessionCache.delete(process_id);
      resetCircuitBreaker(process_id);
      
      emissionStatuses.set(process_id, 'idle');
      sendLog(process_id, 'success', `Emisión detenida correctamente`);
      
      res.json({ 
        success: true, 
        message: `Emisión ${process_id} detenida correctamente` 
      });
    } else {
      // IMPORTANTE: Marcar como parada manual incluso sin proceso activo,
      // para cancelar cualquier recovery programado (setTimeout pendiente)
      manualStopProcesses.add(process_id);
      manualStopProcesses.add(Number(process_id));

      if (persistedPid) {
        emissionStatuses.set(process_id, 'stopping');
        const killedPersistedPid = await killPidIfAlive(persistedPid);
        sendLog(
          process_id,
          killedPersistedPid ? 'success' : 'warn',
          killedPersistedPid
            ? `Proceso heredado PID ${persistedPid} detenido tras actualización`
            : `No se pudo confirmar la detención del PID heredado ${persistedPid}`
        );
      }
      
      // Limpiar estado en DB por si quedó marcado como activo
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'stopped',
            ended_at: new Date().toISOString(),
            start_time: 0,
            elapsed: 0,
            ffmpeg_pid: null,
            recovery_count: 0,
            last_signal_duration: 0,
            failure_reason: null,
            failure_details: null,
          })
          .eq('id', numericProcessId);
      }
      
      emissionStatuses.set(process_id, 'idle');
      sendLog(process_id, 'info', `No hay emisión activa (recovery pendiente cancelado si existía)`);
      res.json({ 
        success: true, 
        message: `Proceso ${process_id} marcado como detenido` 
      });
    }
    
  } catch (error) {
    const pid = req.body?.process_id || '0';
    sendLog(pid, 'error', `Error deteniendo emisión: ${error.message}`);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});


// ── Endpoint /api/emit/restart ────────────────────────────────────────
// Reinicio MANUAL en caliente: detiene FFmpeg actual, invalida la cache de
// sesión de scraping (cookies/token) para forzar un re-login completo, y
// vuelve a arrancar la emisión. El nuevo arranque elige automáticamente un
// User-Agent rotativo distinto (ver pickRandomUserAgent en /api/emit), lo
// que equivale a "abrir una sesión fresca como cliente nuevo".
// ESTE FLUJO ES INDEPENDIENTE DEL "Encendido siempre": no toca always_on.
app.post('/api/emit/restart', async (req, res) => {
  try {
    const { process_id: rawProcessId = '0', source_m3u8, target_rtmp } = req.body;
    const process_id = String(rawProcessId);
    const numericProcessId = parseInt(process_id, 10);

    if (isNaN(numericProcessId) || numericProcessId < 0 || numericProcessId > 18) {
      return res.status(400).json({ error: `ID inválido: ${rawProcessId}` });
    }

    sendLog(process_id, 'info', `🔄 Reinicio manual solicitado — preparando sesión fresca`);

    // 1) Detener FFmpeg actual (sin tocar always_on, sin marcar parada manual permanente).
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (processData && processData.process && !processData.process.killed) {
      emissionStatuses.set(process_id, 'stopping');
      const procRef = processData.process;
      procRef.kill('SIGTERM');
      await waitForProcessDeath(procRef, 3000);
      if (!procRef.killed) {
        procRef.kill('SIGKILL');
        await waitForProcessDeath(procRef, 2000);
      }
      ffmpegProcesses.delete(process_id);
      await stopTigoProxy(process_id).catch(() => {});
      detectedErrors.delete(process_id);
      quickRetryState.delete(process_id);
      lastFrameTime.delete(process_id);
      lastProgressLog.delete(process_id);
      sendLog(process_id, 'info', `🛑 FFmpeg anterior detenido para reinicio en caliente`);
    }

    // 2) Invalidar cache de sesión de scraping → fuerza re-login limpio.
    scrapeSessionCache.delete(process_id);
    scrapeSessionCache.delete(Number(process_id));
    sendLog(process_id, 'info', `🧹 Cache de sesión limpiada (cookies/token serán re-generados)`);

    // 3) Resetear contadores y flags transitorios. NO tocar always_on.
    recoveryAttempts.set(process_id, 0);
    manualStopProcesses.delete(process_id);
    manualStopProcesses.delete(Number(process_id));
    resetCircuitBreaker(process_id);
    emissionStatuses.set(process_id, 'idle');

    // 4) Resolver source/target: si no vino del cliente, intentar leer DB.
    let effectiveSource = source_m3u8;
    let effectiveTarget = target_rtmp;
    if ((!effectiveSource || !effectiveTarget) && supabase) {
      const { data: row } = await supabase
        .from('emission_processes')
        .select('m3u8, rtmp')
        .eq('id', numericProcessId)
        .maybeSingle();
      if (row) {
        effectiveSource = effectiveSource || row.m3u8;
        effectiveTarget = effectiveTarget || row.rtmp;
      }
    }

    if (!effectiveTarget) {
      sendLog(process_id, 'error', `❌ No hay RTMP destino conocido para reiniciar`);
      return res.status(400).json({ error: 'No hay target_rtmp para reiniciar' });
    }

    sendLog(process_id, 'info', `🎭 Arrancando con User-Agent rotativo nuevo...`);

    // 5) Re-disparar /api/emit internamente (mismo proceso, sin HTTP loop real).
    //    Para esto hacemos una llamada HTTP local al propio servidor.
    const port = process.env.PORT || 3000;
    const restartResp = await fetch(`http://127.0.0.1:${port}/api/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_m3u8: effectiveSource,
        target_rtmp: effectiveTarget,
        process_id,
        is_recovery: false, // arranque limpio, NO recovery (forza refresh de token)
      }),
    });

    const restartData = await restartResp.json().catch(() => ({}));
    if (!restartResp.ok) {
      sendLog(process_id, 'error', `❌ Reinicio falló: ${restartData?.error || restartResp.statusText}`);
      return res.status(restartResp.status).json(restartData);
    }

    sendLog(process_id, 'success', `✅ Reinicio en caliente completado con sesión fresca`);
    return res.json({ success: true, message: 'Proceso reiniciado con sesión fresca', detail: restartData });
  } catch (error) {
    const pid = req.body?.process_id || '0';
    sendLog(pid, 'error', `Error en reinicio: ${error.message}`);
    return res.status(500).json({ error: 'Error interno', details: error.message });
  }
});

// Nuevo endpoint para eliminar completamente un proceso específico de la base de datos
app.delete('/api/emit/:process_id', async (req, res) => {
  try {
    const { process_id } = req.params;
    sendLog(process_id, 'info', `Solicitada eliminación del proceso ${process_id}`);
    
    // Primero detener el proceso si está corriendo
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (processData && processData.process && !processData.process.killed) {
      manualStopProcesses.add(process_id); // Marcar como manual para evitar auto-recovery
      manualStopProcesses.add(Number(process_id));
      const procRef = processData.process;
      procRef.kill('SIGKILL');
      ffmpegProcesses.delete(process_id);
      stopTigoProxy(process_id).catch(() => {});
      emissionStatuses.set(process_id, 'idle');
      
      // Matar por PID como respaldo
      if (procRef.pid) {
        setTimeout(() => {
          try {
            process.kill(procRef.pid, 0);
            execSync(`kill -9 ${procRef.pid}`, { timeout: 2000 });
          } catch (e) { /* ya murió */ }
        }, 2000);
      }
    }
    
    // Eliminar de la base de datos solo este proceso específico (solo si Supabase está disponible)
    if (supabase) {
      const { error } = await supabase
        .from('emission_processes')
        .delete()
        .eq('id', parseInt(process_id));
      
      if (error) {
        sendLog(process_id, 'error', `Error eliminando de DB: ${error.message}`);
        return res.status(500).json({ 
          error: 'Error eliminando proceso', 
          details: error.message 
        });
      }
      
      sendLog(process_id, 'success', `✅ Proceso ${process_id} eliminado completamente de la base de datos`);
    } else {
      sendLog(process_id, 'warn', 'Supabase no configurado: solo se detuvo el proceso en memoria, no se eliminó de la base de datos.');
    }
    
    res.json({ 
      success: true, 
      message: `Proceso ${process_id} eliminado correctamente` 
    });
  } catch (error) {
    console.error('❌ Error eliminando proceso:', error);
    res.status(500).json({ 
      error: 'Error eliminando proceso', 
      details: error.message 
    });
  }
});

// Endpoint para borrar archivos subidos
app.delete('/api/emit/files', (req, res) => {
  try {
    const { process_id = '3' } = req.body;
    sendLog(process_id, 'info', `Solicitada eliminación de archivos`);
    
    // Detener proceso si está activo
    const processData = ffmpegProcesses.get(process_id);
    if (processData && processData.process && !processData.process.killed) {
      processData.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
    }
    
    // Eliminar archivos del directorio uploads para este proceso
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      let deletedCount = 0;
      
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
          sendLog(process_id, 'info', `Archivo eliminado: ${file}`);
        } catch (e) {
          console.error(`Error eliminando archivo ${file}:`, e);
        }
      });
      
      sendLog(process_id, 'success', `${deletedCount} archivos eliminados`);
      res.json({ 
        success: true, 
        message: `${deletedCount} archivos eliminados`,
        deletedCount 
      });
    } else {
      res.json({ 
        success: true, 
        message: 'No hay archivos para eliminar',
        deletedCount: 0 
      });
    }
    
  } catch (error) {
    const process_id = req.body.process_id || '3';
    console.error(`❌ Error eliminando archivos [${process_id}]:`, error);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});



app.get('/api/status', (req, res) => {
  const { process_id } = req.query;
  
  if (process_id) {
    // Estado de un proceso específico
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(String(process_id));
    const status = emissionStatuses.get(process_id) || 'idle';
    res.json({
      process_id,
      status,
      process_running: processData && processData.process && !processData.process.killed,
      timestamp: new Date().toISOString()
    });
  } else {
    // Estado de todos los procesos
    const allStatuses = {};
    for (let i = 0; i <= 15; i++) {
      const id = i.toString();
      const processData = ffmpegProcesses.get(id) ?? ffmpegProcesses.get(String(id));
      allStatuses[id] = {
        status: emissionStatuses.get(id) || 'idle',
        process_running: processData && processData.process && !processData.process.killed
      };
    }
    res.json({
      processes: allStatuses,
      timestamp: new Date().toISOString()
    });
  }
});

// ============= LOG SNAPSHOTS API =============
// GET /api/log-snapshots/:processId  → últimos 3 snapshots de logs del proceso
app.get('/api/log-snapshots/:processId', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
  const pid = Number(req.params.processId);
  if (!Number.isFinite(pid)) return res.status(400).json({ error: 'process_id inválido' });
  try {
    const { data, error } = await supabase
      .from('process_log_snapshots')
      .select('*')
      .eq('process_id', pid)
      .order('created_at', { ascending: false })
      .limit(3);
    if (error) throw error;
    res.json({ snapshots: data || [] });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
  res.json({
    healthy: true,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rtmp-health', (req, res) => {
  const socket = net.createConnection({ host: '127.0.0.1', port: 1935 });
  let settled = false;

  const finish = (payload, status = 200) => {
    if (settled) return;
    settled = true;
    try { socket.destroy(); } catch (_) {}
    return res.status(status).json(payload);
  };

  socket.setTimeout(2500);
  socket.once('connect', () => finish({ healthy: true, host: '127.0.0.1', port: 1935 }));
  socket.once('timeout', () => finish({ healthy: false, error: 'timeout', host: '127.0.0.1', port: 1935 }, 503));
  socket.once('error', (error) => finish({ healthy: false, error: error.code || error.message, host: '127.0.0.1', port: 1935 }, 503));
});

// Endpoint para obtener la URL HLS de un proceso
app.get('/api/hls-url', (req, res) => {
  const { process_id } = req.query;
  if (!process_id || !HLS_OUTPUT_PROCESSES.has(String(process_id))) {
    return res.status(400).json({ error: 'Proceso no es HLS output' });
  }
  const slug = HLS_SLUG_MAP[String(process_id)] || `stream_${process_id}`;
  const hlsPath = `/live/${slug}/playlist.m3u8`;
  res.json({ success: true, path: hlsPath, slug });
});


// ===== MÉTRICAS DEL SERVIDOR =====
let prevCpuTimes = null;
let prevNetStats = null;

const getCpuUsage = () => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  
  const currentTimes = { idle: totalIdle, total: totalTick };
  
  if (prevCpuTimes) {
    const idleDiff = currentTimes.idle - prevCpuTimes.idle;
    const totalDiff = currentTimes.total - prevCpuTimes.total;
    const usage = totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100) : 0;
    prevCpuTimes = currentTimes;
    return Math.round(usage * 10) / 10;
  }
  
  prevCpuTimes = currentTimes;
  return 0;
};

const getNetworkStats = () => {
  try {
    const interfaces = os.networkInterfaces();
    // Try reading /proc/net/dev for actual bytes (Linux only)
    if (fs.existsSync('/proc/net/dev')) {
      const content = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = content.split('\n').slice(2); // Skip headers
      let totalRx = 0, totalTx = 0;
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10 && !parts[0].startsWith('lo:')) {
          totalRx += parseInt(parts[1]) || 0;
          totalTx += parseInt(parts[9]) || 0;
        }
      });
      
      const current = { rx: totalRx, tx: totalTx, time: Date.now() };
      
      if (prevNetStats) {
        const elapsed = (current.time - prevNetStats.time) / 1000;
        const rxRate = elapsed > 0 ? ((current.rx - prevNetStats.rx) / elapsed / 1024 / 1024) : 0; // MB/s
        const txRate = elapsed > 0 ? ((current.tx - prevNetStats.tx) / elapsed / 1024 / 1024) : 0; // MB/s
        prevNetStats = current;
        return {
          rxMbps: Math.round(rxRate * 100) / 100,
          txMbps: Math.round(txRate * 100) / 100
        };
      }
      
      prevNetStats = current;
      return { rxMbps: 0, txMbps: 0 };
    }
    
    return { rxMbps: 0, txMbps: 0 };
  } catch (e) {
    return { rxMbps: 0, txMbps: 0 };
  }
};

app.get('/api/metrics', (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    const cpuUsage = getCpuUsage();
    const network = getNetworkStats();
    
    res.json({
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        cores: os.cpus().length
      },
      memory: {
        total: Math.round(totalMem / 1024 / 1024), // MB
        used: Math.round(usedMem / 1024 / 1024),
        free: Math.round(freeMem / 1024 / 1024),
        percent: Math.round((usedMem / totalMem) * 1000) / 10
      },
      network: {
        rxMbps: network.rxMbps,
        txMbps: network.txMbps
      },
      uptime: os.uptime(),
      loadAvg: os.loadavg()
    });
  } catch (error) {
    // Nunca devolver 500 al dashboard de métricas
    res.status(200).json({
      timestamp: Date.now(),
      cpu: { usage: 0, cores: 0 },
      memory: { total: 0, used: 0, free: 0, percent: 0 },
      network: { rxMbps: 0, txMbps: 0 },
      uptime: 0,
      loadAvg: [0, 0, 0],
      degraded: true,
      reason: 'metrics_unavailable'
    });
  }
});

// Endpoints /api/proxy-status y /api/tigo-srt-status eliminados (Tigo descartado).
app.use((req, res, next) => {
  // Solo servir index.html para rutas del frontend.
  // Nunca interceptar APIs ni WebSocket upgrades, porque eso hace que
  // endpoints como /api/always-on respondan 200 con HTML en vez de JSON.
  if (!req.path.startsWith('/api') && !req.path.includes('.') && req.method === 'GET') {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    next();
  }
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
  sendLog('system', 'warn', 'Cerrando servidor...');
  ffmpegProcesses.forEach((processData, processId) => {
    if (processData.process && !processData.process.killed) {
      sendLog(processId, 'warn', `Deteniendo ffmpeg por cierre del servidor`);
      processData.process.kill('SIGTERM');
    }
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  sendLog('system', 'warn', 'Recibida señal SIGTERM, cerrando servidor...');
  ffmpegProcesses.forEach((processData, processId) => {
    if (processData.process && !processData.process.killed) {
      sendLog(processId, 'warn', `Deteniendo ffmpeg por SIGTERM`);
      processData.process.kill('SIGTERM');
    }
  });
  process.exit(0);
});

// ====== NIGHT REST SCHEDULER ======
// Checks every minute if any process with night_rest=true needs to stop (1AM) or start (5AM)
// Uses Costa Rica time (UTC-6) for scheduling
// nightRestStoppedProcesses is declared at top with other global Sets
function getCostaRicaHour() {
  const now = new Date();
  // Costa Rica is UTC-6 (no daylight saving)
  const utcHours = now.getUTCHours();
  const crHour = (utcHours - 6 + 24) % 24;
  return { hour: crHour, minute: now.getUTCMinutes() };
}

setInterval(async () => {
  if (!supabase) return;
  
  const { hour, minute } = getCostaRicaHour();
  
  // Only act at exact hour transitions (minute 0) to avoid repeated actions
  if (minute !== 0) return;
  
  try {
    const { data: rows, error } = await supabase
      .from('emission_processes')
      .select('id, night_rest, is_emitting, emit_status, m3u8, rtmp, source_url')
      .eq('night_rest', true);
    
    if (error || !rows) return;
    
    for (const row of rows) {
      const pid = String(row.id);
      
      // 1 AM: Stop processes that are emitting
      if (hour === 1 && row.is_emitting) {
        sendLog(pid, 'info', `🌙 Descanso nocturno: Apagando ${CHANNEL_CONFIGS_SERVER[pid] || `Proceso ${pid}`} hasta las 5AM...`);
        nightRestStoppedProcesses.add(pid);
        manualStopProcesses.add(pid);
        manualStopProcesses.add(Number(pid));
        
        // Kill the FFmpeg process
        const processData = ffmpegProcesses.get(pid) || ffmpegProcesses.get(Number(pid));
        if (processData && processData.process && !processData.process.killed) {
          processData.process.kill('SIGTERM');
        }
        
        // Update DB
        await supabase.from('emission_processes').update({
          is_emitting: false,
          is_active: false,
          emit_status: 'idle',
          emit_msg: '🌙 Descanso nocturno (se enciende a las 5AM)',
        }).eq('id', row.id);
        
        sendLog(pid, 'success', `🌙 Proceso apagado por descanso nocturno`);
      }
      
      // 5 AM: Start processes that were stopped by night rest
      if (hour === 5 && !row.is_emitting && nightRestStoppedProcesses.has(pid)) {
        nightRestStoppedProcesses.delete(pid);
        manualStopProcesses.delete(pid);
        manualStopProcesses.delete(Number(pid));
        
        sendLog(pid, 'info', `☀️ Descanso nocturno terminado: Encendiendo ${CHANNEL_CONFIGS_SERVER[pid] || `Proceso ${pid}`}...`);
        
        // TDMax channels need a fresh URL via scraping
        if (CHANNEL_MAP[pid]) {
          const { channelId, channelName } = CHANNEL_MAP[pid];
          sendLog(pid, 'info', `🔄 ${channelName}: Obteniendo URL fresca para arranque matutino...`);
          await autoRecoverChannel(pid, channelId, channelName);
        } else if (MANUAL_URL_PROCESSES.has(pid)) {
          // Disney/Canal 6: restart with existing URL from DB
          const sourceUrl = row.source_url || row.m3u8;
          const targetRtmp = row.rtmp;
          
          if (sourceUrl && targetRtmp) {
            sendLog(pid, 'info', `🔄 Reiniciando con URL existente...`);
            await supabase.from('emission_processes').update({
              emit_status: 'starting',
              is_emitting: true,
              is_active: true,
            }).eq('id', row.id);
            
            try {
              await fetch(`http://localhost:${PORT}/api/emit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source_m3u8: sourceUrl,
                  target_rtmp: targetRtmp,
                  process_id: pid,
                  is_recovery: true,
                }),
              });
            } catch (err) {
              sendLog(pid, 'error', `❌ Error al arrancar: ${err.message}`);
            }
          } else {
            sendLog(pid, 'warn', `⚠️ No hay URL guardada para arrancar automáticamente`);
          }
        }
      }
    }
  } catch (err) {
    console.error('Night rest scheduler error:', err);
  }
}, 60000); // Check every minute

// Server-side channel name map for logs
const CHANNEL_CONFIGS_SERVER = {
  '0': 'Disney 7', '1': 'FUTV', '3': 'TDmas 1', '4': 'Teletica',
  '5': 'Canal 6', '6': 'Multimedios', '7': 'Subida', '10': 'Disney 8',
  '11': 'FUTV URL', '12': 'TIGO SRT', '13': 'TELETICA URL', '14': 'TDMAS 1 URL', '15': 'CANAL 6 URL',
  '16': 'DISNEY 7 SRT', '17': 'FUTV ALTERNO', '18': 'FUTV SRT',
};

// Endpoint para toggle night_rest
app.post('/api/night-rest', async (req, res) => {
  try {
    const { process_id, enabled } = req.body;
    if (process_id === undefined || enabled === undefined) {
      return res.status(400).json({ error: 'Faltan parámetros: process_id, enabled' });
    }
    
    if (!supabase) {
      return res.status(500).json({ error: 'Base de datos no disponible' });
    }
    
    const { error } = await supabase
      .from('emission_processes')
      .update({ night_rest: enabled })
      .eq('id', Number(process_id));
    
    if (error) throw error;
    
    const label = CHANNEL_CONFIGS_SERVER[String(process_id)] || `Proceso ${process_id}`;
    sendLog(String(process_id), 'info', `${enabled ? '🌙' : '☀️'} Descanso nocturno ${enabled ? 'activado' : 'desactivado'} para ${label}`);
    
    if (!enabled) {
      nightRestStoppedProcesses.delete(String(process_id));
    }
    
    res.json({ success: true, night_rest: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para toggle always_on ("Encendido siempre")
app.post('/api/always-on', async (req, res) => {
  try {
    const { process_id, enabled } = req.body;
    if (process_id === undefined || enabled === undefined) {
      return res.status(400).json({ error: 'Faltan parámetros: process_id, enabled' });
    }
    if (!supabase) {
      return res.status(500).json({ error: 'Base de datos no disponible' });
    }
    if (String(process_id) === '12' || String(process_id) === '16' || String(process_id) === '18') {
      const labels = { '12': 'TIGO SRT', '16': 'DISNEY 7 SRT', '18': 'FUTV SRT' };
      const label = labels[String(process_id)];
      return res.status(400).json({ error: `${label} no admite "Encendido siempre" (depende de OBS local)` });
    }
    // FUTV ALTERNO (17): solo permitir always_on si tiene player_url guardada
    if (String(process_id) === '17' && enabled) {
      const { data: row17 } = await supabase
        .from('emission_processes')
        .select('player_url')
        .eq('id', 17)
        .maybeSingle();
      if (!row17?.player_url) {
        return res.status(400).json({
          error: 'FUTV ALTERNO requiere extraer una URL del player TDMax antes de activar "Encendido siempre".',
        });
      }
    }

    const update = { always_on: !!enabled };
    if (enabled) {
      // Inicializar la marca de refresh para que el contador de 10h arranque desde ya
      update.last_refresh_at = new Date().toISOString();
    } else {
      update.last_refresh_at = null;
    }

    const { error } = await supabase
      .from('emission_processes')
      .update(update)
      .eq('id', Number(process_id));

    if (error) throw error;

    const label = CHANNEL_CONFIGS_SERVER[String(process_id)] || `Proceso ${process_id}`;
    sendLog(String(process_id), 'info', `${enabled ? '🔁' : '⏹️'} Encendido siempre ${enabled ? 'activado' : 'desactivado'} para ${label}`);

    const { data: updatedRow } = await supabase
      .from('emission_processes')
      .select('always_on, last_refresh_at')
      .eq('id', Number(process_id))
      .single();

    res.json({ success: true, always_on: Boolean(updatedRow?.always_on), last_refresh_at: updatedRow?.last_refresh_at ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar el servidor HTTP (que incluye WebSocket)
server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP+WebSocket iniciado en puerto ${PORT}`);
  console.log(`📡 Panel disponible en: http://localhost:${PORT}`);
  console.log(`🔧 Asegúrate de tener FFmpeg instalado y accesible en PATH`);  
  console.log(`📋 WebSocket logs disponibles en: ws://localhost:${PORT}/ws`);
  sendLog('system', 'success', `Servidor iniciado en puerto ${PORT}`);

  if (supabase) {
    // Crear SOLO las filas que no existen. NUNCA resetear estado de filas existentes
    // (esto borraba is_emitting/always_on tras cada reinicio del servidor).
    (async () => {
      try {
        const { data: existingRows } = await supabase
          .from('emission_processes')
          .select('id');
        const existingIds = new Set((existingRows || []).map(r => r.id));
        const missingRows = [];
        for (let id = 0; id <= 18; id++) {
          if (!existingIds.has(id)) {
            missingRows.push({
              id,
              m3u8: '',
              rtmp: '',
              preview_suffix: '/video.m3u8',
              is_emitting: false,
              active_time: 0,
              down_time: 0,
              elapsed: 0,
              start_time: 0,
              emit_status: 'idle',
              emit_msg: '',
            });
          }
        }
        if (missingRows.length > 0) {
          await supabase.from('emission_processes').insert(missingRows);
          console.log(`✅ Creadas ${missingRows.length} filas faltantes en emission_processes`);
        }
      } catch (err) {
        console.error('Error verificando filas base de emission_processes:', err.message);
      }
    })();

    // Fijar presets SRT al arrancar (Tigo, Disney 7, FUTV SRT)
    for (const id of [12, 16, 18]) {
      supabase
        .from('emission_processes')
        .update({ m3u8: 'srt://obs', rtmp: 'hls-local' })
        .eq('id', id)
        .then(({ error }) => {
          if (error) console.error(`Error fijando preset SRT (id=${id}) al iniciar servidor:`, error.message);
        });
    }

    // ====== RECUPERACIÓN AL ARRANCAR: levantar canales con always_on=true ======
    // Espera 8s para que el servidor esté completamente listo y luego relanza
    // todas las emisiones marcadas como "Encendido siempre".
    setTimeout(async () => {
      try {
        const { data: alwaysOnRows, error } = await supabase
          .from('emission_processes')
          .select('id, source_url, m3u8, rtmp, always_on, player_url')
          .eq('always_on', true);

        if (error || !alwaysOnRows || alwaysOnRows.length === 0) return;

        sendLog('system', 'info', `🔁 Recuperando ${alwaysOnRows.length} emisión(es) con "Encendido siempre"...`);

        for (const row of alwaysOnRows) {
          const pid = String(row.id);
          // TIGO SRT (12), DISNEY 7 SRT (16) y FUTV SRT (18) se autoarrancan por su propio path.
          // FUTV ALTERNO (17) sí se relanza si tiene player_url guardada (re-scrape fresco).
          if (pid === '12' || pid === '16' || pid === '18') continue;

          // Limpiar manualStop por si quedó marcado
          manualStopProcesses.delete(pid);
          manualStopProcesses.delete(Number(pid));

          try {
            if (CHANNEL_MAP[pid]) {
              // Canales scrapeados: obtener URL fresca
              const { channelId, channelName } = CHANNEL_MAP[pid];
              sendLog(pid, 'info', `🔁 Always-on: relanzando ${channelName} con scraping fresco...`);
              await autoRecoverChannel(pid, channelId, channelName);
            } else if (pid === '17') {
              // FUTV ALTERNO: re-scrape con player_url persistido
              const playerUrl = row.player_url;
              if (!playerUrl) {
                sendLog('17', 'warn', `⚠️ Always-on activo pero no hay player_url guardada (volver a extraer)`);
              } else {
                const m = String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i);
                const channelId = m ? m[1] : null;
                if (!channelId) {
                  sendLog('17', 'error', `❌ player_url inválida: ${playerUrl}`);
                } else {
                  sendLog('17', 'info', `🔁 Always-on: re-scrapeando FUTV ALTERNO con player_url guardada...`);
                  await autoRecoverChannel('17', channelId, 'FUTV ALTERNO');
                }
              }
            } else {
              // Canales manuales (ej. ID 15 CANAL 6 URL): usar última URL guardada
              const sourceUrl = row.source_url || row.m3u8;
              const targetRtmp = row.rtmp;
              if (sourceUrl && targetRtmp) {
                sendLog(pid, 'info', `🔁 Always-on: relanzando con última URL guardada...`);
                await fetch(`http://localhost:${PORT}/api/emit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: sourceUrl,
                    target_rtmp: targetRtmp,
                    process_id: pid,
                    is_recovery: true,
                  }),
                });
              } else {
                sendLog(pid, 'warn', `⚠️ Always-on activo pero no hay URL guardada para relanzar`);
              }
            }
            // Pequeño escalonamiento para no saturar
            await new Promise(r => setTimeout(r, 2500));
          } catch (e) {
            sendLog(pid, 'error', `❌ Error relanzando always-on: ${e.message}`);
          }
        }
      } catch (err) {
        console.error('Error en recuperación always-on al arrancar:', err);
      }
    }, 8000);

    // ====== AUTO-REFRESH HORARIO FIJO: reinicia canales always_on a las 00:00 y 05:00 hora Costa Rica ======
    // Solo afecta filas con always_on=true Y is_emitting=true (no relanza canales que el usuario apagó).
    // Usamos last_refresh_at como guard para no disparar dos veces en la misma ventana horaria (60 min).
    const REFRESH_HOURS_CR = [3]; // 3:00 AM hora Costa Rica (1 sola ventana diaria)
    const REFRESH_GUARD_MS = 60 * 60 * 1000; // no re-disparar dentro de la misma hora
    setInterval(async () => {
      try {
        const { hour: crHour, minute: crMinute } = getCostaRicaHour();
        // Solo actuar en los primeros 5 minutos de la hora objetivo
        if (!REFRESH_HOURS_CR.includes(crHour) || crMinute >= 5) return;

        const { data: rows } = await supabase
          .from('emission_processes')
          .select('id, source_url, m3u8, rtmp, always_on, last_refresh_at, is_emitting, player_url')
          .eq('always_on', true)
          .eq('is_emitting', true);
        if (!rows || rows.length === 0) return;

        const now = Date.now();
        for (const row of rows) {
          const pid = String(row.id);
          if (pid === '12' || pid === '16' || pid === '18') continue; // SRT/OBS locales excluidos. FUTV ALTERNO (17) sí refresca si tiene player_url.

          // Guard: si refrescamos hace <60 min, saltar (evita doble disparo en la misma ventana)
          const lastRefresh = row.last_refresh_at ? new Date(row.last_refresh_at).getTime() : 0;
          if (now - lastRefresh < REFRESH_GUARD_MS) continue;

          sendLog(pid, 'info', `⏰ Refresh programado (${String(crHour).padStart(2, '0')}:00 CR): reiniciando con URL fresca...`);

          // Marcar refresh ahora para evitar loops si algo falla
          await supabase
            .from('emission_processes')
            .update({ last_refresh_at: new Date().toISOString() })
            .eq('id', row.id);

          try {
            // Detener proceso actual limpiamente
            await fetch(`http://localhost:${PORT}/api/emit/stop`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ process_id: pid, internal_refresh: true }),
            });
            await new Promise(r => setTimeout(r, 3000));

            // Limpiar manualStop ya que es un refresh interno, no un stop del usuario
            manualStopProcesses.delete(pid);
            manualStopProcesses.delete(Number(pid));

            if (CHANNEL_MAP[pid]) {
              const { channelId, channelName } = CHANNEL_MAP[pid];
              await autoRecoverChannel(pid, channelId, channelName);
            } else if (pid === '17') {
              const playerUrl = row.player_url;
              const m = playerUrl ? (String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i)) : null;
              const channelId = m ? m[1] : null;
              if (!channelId) {
                sendLog('17', 'error', `❌ Refresh 17: player_url inválida o ausente, omitiendo`);
              } else {
                sendLog('17', 'info', `🔄 Refresh 3:00 CR: re-scrapeando FUTV ALTERNO con player_url guardada...`);
                await autoRecoverChannel('17', channelId, 'FUTV ALTERNO');
              }
            } else {
              const sourceUrl = row.source_url || row.m3u8;
              const targetRtmp = row.rtmp;
              if (sourceUrl && targetRtmp) {
                await fetch(`http://localhost:${PORT}/api/emit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: sourceUrl,
                    target_rtmp: targetRtmp,
                    process_id: pid,
                    is_recovery: true,
                  }),
                });
              }
            }
            sendLog(pid, 'success', `✅ Refresh programado completado`);
          } catch (e) {
            sendLog(pid, 'error', `❌ Error en refresh programado: ${e.message}`);
          }
        }
      } catch (err) {
        console.error('Error en scheduler refresh programado:', err);
      }
    }, 60 * 1000); // chequea cada 1 min (ventana de actuación de 5 min al inicio de la hora objetivo)
  }

  setTimeout(async () => {
    try {
      const tigoRunning = ffmpegProcesses.get('12');
      if (tigoRunning?.process && !tigoRunning.process.killed) return;

      sendLog('12', 'info', '🚀 Auto-arranque TIGO SRT al iniciar servidor...');
      await fetch(`http://localhost:${PORT}/api/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_m3u8: 'srt://obs',
          target_rtmp: 'hls-local',
          process_id: '12'
        })
      });
    } catch (error) {
      console.error('Error auto-arrancando TIGO SRT:', error);
    }
  }, 1500);

  // Auto-arranque DISNEY 7 SRT (id 16): salida HLS local lista para recibir SRT de OBS
  setTimeout(async () => {
    try {
      const disneyRunning = ffmpegProcesses.get('16');
      if (disneyRunning?.process && !disneyRunning.process.killed) return;

      sendLog('16', 'info', '🚀 Auto-arranque DISNEY 7 SRT al iniciar servidor...');
      await fetch(`http://localhost:${PORT}/api/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_m3u8: 'srt://obs',
          target_rtmp: 'hls-local',
          process_id: '16'
        })
      });
    } catch (error) {
      console.error('Error auto-arrancando DISNEY 7 SRT:', error);
    }
  }, 2500);

  // Auto-arranque FUTV SRT (id 18): salida HLS local lista para recibir SRT de OBS
  setTimeout(async () => {
    try {
      const futvSrtRunning = ffmpegProcesses.get('18');
      if (futvSrtRunning?.process && !futvSrtRunning.process.killed) return;

      sendLog('18', 'info', '🚀 Auto-arranque FUTV SRT al iniciar servidor...');
      await fetch(`http://localhost:${PORT}/api/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_m3u8: 'srt://obs',
          target_rtmp: 'hls-local',
          process_id: '18'
        })
      });
    } catch (error) {
      console.error('Error auto-arrancando FUTV SRT:', error);
    }
  }, 3500);
});
