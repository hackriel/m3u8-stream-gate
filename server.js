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
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { request as undiciRequest, ProxyAgent } from 'undici';

// FOX/FOX+ URL filler (pantalla "RECONECTANDO" mientras se re-scrape)
import { startFiller as foxStartFiller, stopFillerAndWait as foxStopFillerAndWait, isFillerActive as foxIsFillerActive, isFillerSupported as foxIsFillerSupported } from './fox-filler.js';

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
const APP_BUILD_MARKER = 'tdmax-app-headers-2026-05-24b';
const TDMAX_LB_PARAM_MODE = 'device-id/access_token/country_code/device-name/device-type';
// CRÍTICO: cdn02/cdn12.teletica.com valida Origin/Referer literal contra
// "https://www.app.tdmax.com" (con www). Sin www, /FoxSport*/ devuelve
// 200+chunks vacíos o 403 directo. Debe coincidir con el edge function
// scrape-channel y con teletica-cdn-origin-tdmax.md.
const TDMAX_APP_ORIGIN = 'https://www.app.tdmax.com';
const TDMAX_APP_REFERER = `${TDMAX_APP_ORIGIN}/`;
const TDMAX_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TDMAX_BROWSER_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
  'x-app-name': 'TDMAX',
  'x-app-platform': 'web',
  'x-app-version': '3.1.1',
};

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

// ───────────────────────────────────────────────────────────────────────
// Limpia el directorio HLS de un pid (borra playlist.m3u8 + segmentos) para
// que los clientes (XUI/Odin) reciban 404 y caigan a su URL de backup.
// Guard: si OTRO pid comparte el mismo slug y está vivo, NO limpia.
// ───────────────────────────────────────────────────────────────────────
function clearHlsSlugForPid(pid, logTag = null) {
  const slug = (typeof HLS_SLUG_MAP !== 'undefined') ? HLS_SLUG_MAP[String(pid)] : null;
  if (!slug) return false;
  // ¿Hay OTRO proceso vivo escribiendo al mismo slug?
  for (const [otherPid, otherSlug] of Object.entries(HLS_SLUG_MAP)) {
    if (otherPid === String(pid)) continue;
    if (otherSlug !== slug) continue;
    if (ffmpegProcesses && (ffmpegProcesses.has(otherPid) || ffmpegProcesses.has(Number(otherPid)))) {
      return false; // alguien más sigue escribiendo, no limpiamos
    }
  }
  const dir = path.join(HLS_OUTPUT_DIR, slug);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      try { sendLog(pid, 'info', `🧹 HLS /live/${slug} limpiado${logTag ? ` (${logTag})` : ''} — clientes caerán a backup`); } catch (_) {}
      return true;
    }
  } catch (e) {
    try { sendLog(pid, 'warn', `⚠️ No se pudo limpiar /live/${slug}: ${e.message}`); } catch (_) {}
  }
  return false;
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


// ===== CANAL 6 MPEG-TS PASSTHROUGH =====
// ÚNICAMENTE para Canal 6 (ID 15). Los demás canales siguen como HLS normal.
// XUI apunta a http://host:3001/canal6.ts → remuxea /live/Canal6/playlist.m3u8 a MPEG-TS continuo.
app.get('/canal6.ts', (req, res) => {
  const playlist = path.join(HLS_OUTPUT_DIR, 'Canal6', 'playlist.m3u8');
  if (!fs.existsSync(playlist)) {
    return res.status(404).type('text/plain').send('Canal 6 no está activo');
  }

  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Connection', 'keep-alive');

  const args = [
    '-loglevel', 'error',
    '-fflags', '+nobuffer+genpts',
    '-i', playlist,
    '-c', 'copy',
    '-copyts',
    '-f', 'mpegts',
    'pipe:1'
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';
  ff.stderr.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000); });
  ff.stdout.pipe(res);
  const cleanup = () => { try { ff.kill('SIGKILL'); } catch (_) {} };
  req.on('close', cleanup);
  res.on('close', cleanup);
  ff.on('error', (err) => { try { res.end(); } catch (_) {} console.error('[canal6.ts] ffmpeg error:', err.message); });
  ff.on('exit', (code) => {
    if (code && code !== 0 && code !== 255) {
      console.error(`[canal6.ts] ffmpeg exit ${code}: ${stderrBuf.split('\n').slice(-3).join(' | ')}`);
    }
    try { res.end(); } catch (_) {}
  });
});


// ───────────────────────────────────────────────────────────────────
// EXT-X-START PATCHER (reduce latencia de arranque ~15s)
// Cada 1s revisa TODOS los playlist.m3u8 activos y, si no tienen el tag
// `#EXT-X-START:TIME-OFFSET=0,PRECISE=YES`, lo inyecta justo después de
// `#EXTM3U`. Esto le dice al player/XUI: "empezá desde el inicio de la
// ventana disponible, no desde el final" → la reproducción comienza apenas
// hay 3 segmentos (≈30s), en vez de esperar la latencia clásica de HLS
// (~45s). Es una directiva estándar HLS (RFC 8216 §4.3.5.2): si el player
// no la entiende, simplemente la ignora — riesgo cero.
// FFmpeg sobreescribe el playlist en cada segmento (~10s), por eso el
// patcher reinyecta de forma continua. El costo es despreciable
// (lectura/escritura de un archivo <1KB cada 1s por slug activo).
// ───────────────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const slugs = fs.readdirSync(HLS_OUTPUT_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const slug of slugs) {
      const pl = path.join(HLS_OUTPUT_DIR, slug, 'playlist.m3u8');
      if (!fs.existsSync(pl)) continue;
      try {
        const content = fs.readFileSync(pl, 'utf8');
        if (content.includes('#EXT-X-START')) continue;
        if (!content.startsWith('#EXTM3U')) continue;
        const patched = content.replace(
          '#EXTM3U',
          '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES'
        );
        fs.writeFileSync(pl, patched);
      } catch (_) {}
    }
  } catch (_) {}
}, 1000);

// Variables globales para manejo de múltiples procesos ffmpeg
const ffmpegProcesses = new Map(); // Map<processId, { process, status, startTime, target_rtmp }>
const emissionStatuses = new Map(); // Map<processId, status>
const autoRecoveryInProgress = new Map(); // Map<processId(string), boolean>
const manualStopProcesses = new Set(); // Procesos detenidos manualmente (no hacer auto-recovery)
const nightRestStoppedProcesses = new Set(); // Procesos apagados por descanso nocturno
const detectedErrors = new Map(); // Map<processId, { type, reason }> — último error detectado por stderr
const ignoredLateCloseProcesses = new WeakSet(); // FFmpeg viejos ya manejados por watchdog fallback

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

const shouldCircuitBreakProcess = (processId) => {
  // FOX URL/FOX+ URL usan tokens TDMax cortos y pueden necesitar varios re-scrapes
  // después de un 404 real del CDN. No cortar el auto-recovery por circuito: si
  // always_on está activo, debe seguir intentando con URL fresca.
  // FOX+ ALTERNO (26) usa el mismo mecanismo (player_url eventual + scraping fresco).
  if (['24', '25', '26'].includes(String(processId))) return false;
  return isCircuitBroken(processId);
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
  '15': { channelId: '65d7aca4e4b0140cbf380bd0', channelName: 'CANAL 6 URL' },
  '24': { channelId: '6a10a6a2350cb5151ab6ca8c', channelName: 'FOX+ URL' },
  '25': { channelId: '664237788f085ac1f2a15f81', channelName: 'FOX URL' },
};

// Procesos que emiten a HLS local en vez de RTMP
const HLS_OUTPUT_PROCESSES = new Set(['0', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28']);
// Mapa de slug HLS por proceso (para la ruta /live/<slug>/playlist.m3u8)
// FUTV (11), FUTV ALTERNO (17) y FUTV SRT (18) comparten slug 'futv' a propósito:
// los 3 emiten al MISMO destino HLS local (/live/futv/playlist.m3u8) por métodos distintos
// (scraping, URL manual, SRT desde OBS). El bloqueo mutuo de slug evita que se pisen entre sí
// — el usuario decide cuál de los 3 está activo en cada momento.
// Disney 7 SRT (16) y RANDOM Disney 7 (19) también comparten slug 'Disney7' por la
// misma razón: los 2 emiten al mismo destino /live/Disney7/playlist.m3u8 por métodos
// distintos (SRT desde OBS vs M3U passthrough). Mutuamente excluyentes.
// CANAL 6 URL (15) y CANAL 6 SRT (20) comparten slug 'Canal6' (URL CDN vs ingest SRT desde OBS).
// Disney 7 (ID 0) — M3U file passthrough con perfil VLC-like — también emite al slug 'Disney7'.
// FOX+ URL (24), FOX+ SRT (22) y FOX+ ALTERNO (26) comparten slug 'foxmas' → mutex automático por slug HLS.
// FOX URL (25) y FOX SRT (23) comparten slug 'fox' → mutex automático por slug HLS.
const HLS_SLUG_MAP = { '0': 'Disney7', '11': 'futv', '12': 'Tigo', '13': 'Teletica', '14': 'Tdmas1', '15': 'Canal6', '16': 'Disney7', '17': 'futv', '18': 'futv', '19': 'Disney7', '20': 'Canal6', '21': 'Teletica', '22': 'foxmas', '23': 'fox', '24': 'foxmas', '25': 'fox', '26': 'foxmas', '27': 'Canal8', '28': 'Canal2' };

// ───────────────────────────────────────────────────────────────────────
// TELETICA URL (ID 13) — selector de fuente: 'official' | 'scraping'
//
// • 'official': URL directa del CDN de Teletica vía Bradmax (sin token).
//   Validada manualmente: HTTP 200 + master playlist Nimble con 4 variantes.
//   Solo requiere Referer https://bradmax.com/ — sin login, sin wmsAuthSign.
// • 'scraping': flujo histórico TDMax (login + wmsAuthSign de 60s).
//
// Fallback unidireccional: si 'official' falla durante una emisión activa,
// el recovery cambia AUTOMÁTICAMENTE el modo a 'scraping'. De 'scraping'
// nunca se promueve a 'official' (solo el usuario puede volver a elegir).
// El estado vive en memoria — se reinicia al restart del servicio (default
// 'scraping' = comportamiento histórico).
// ───────────────────────────────────────────────────────────────────────
const TELETICA_OFFICIAL_URL = 'https://cdn01.teletica.com/TeleticaLiveStream/Stream/playlist_dvr.m3u8';
const teleticaSourceMode = new Map(); // process_id (string) -> 'official' | 'scraping'
// Contador de caídas consecutivas en modo OFICIAL Teletica (pid 13).
// Permite reintentar 2 veces con la URL oficial antes de cambiar a SCRAPING.
// Se resetea cuando una emisión oficial sostiene >60s o cuando se vuelve a
// seleccionar manualmente el modo.
const teleticaOfficialFailures = new Map(); // pid -> count
const TELETICA_OFFICIAL_MAX_RETRIES = 2;
const getTeleticaSourceMode = (pid) => (teleticaSourceMode.get(String(pid)) === 'official' ? 'official' : 'scraping');
const setTeleticaSourceMode = (pid, mode) => {
  const m = mode === 'official' ? 'official' : 'scraping';
  teleticaSourceMode.set(String(pid), m);
  // Persistir en DB para que sobreviva reinicios del servicio (fire-and-forget).
  try {
    if (typeof supabase !== 'undefined' && supabase) {
      supabase
        .from('emission_processes')
        .update({ source_mode: m })
        .eq('id', parseInt(String(pid), 10))
        .then(({ error }) => {
          if (error) console.error(`[teleticaSourceMode] persist error pid=${pid}:`, error.message);
        });
    }
  } catch (_) { /* ignorar: persistencia best-effort */ }
  return m;
};

// ───────────────────────────────────────────────────────────────────────
// CANAL 6 URL (15) — toggle Oficial vs Scraping (espejo del de Teletica).
// Reusa la columna persistida `emission_processes.source_mode`.
// Modo 'official' = usar la URL que el usuario pegó en el input (no hay
// CDN fija como Bradmax). Modo 'scraping' = flujo TDMax actual.
// Fallback unidireccional: official → scraping en recovery. De scraping
// nunca se promueve a official (solo el usuario lo selecciona).
// ───────────────────────────────────────────────────────────────────────
const canal6SourceMode = new Map(); // pid (string) -> 'official' | 'scraping'
const getCanal6SourceMode = (pid) =>
  (canal6SourceMode.get(String(pid)) === 'official' ? 'official' : 'scraping');
const setCanal6SourceMode = (pid, mode) => {
  const m = mode === 'official' ? 'official' : 'scraping';
  canal6SourceMode.set(String(pid), m);
  try {
    if (typeof supabase !== 'undefined' && supabase) {
      supabase
        .from('emission_processes')
        .update({ source_mode: m })
        .eq('id', parseInt(String(pid), 10))
        .then(({ error }) => {
          if (error) console.error(`[canal6SourceMode] persist error pid=${pid}:`, error.message);
        });
    }
  } catch (_) {}
  return m;
};

// ───────────────────────────────────────────────────────────────────────
// TELECABLE (piloto: FOX URL pid 25) — tercera fuente alternativa.
//
// Modo 'scraping' = flujo TDMax/CR actual (intacto).
// Modo 'telecable' = login a la API de Telecable/mastele desde la IP del VPS
//   (sin túnel CR), obtención de URL HLS firmada, FFmpeg directo.
//
// La firma del CDN (`signature-ip`) se emite a la IP que hace el GET de
// /api/playlist, por lo que el login DEBE correr aquí en el VPS — no en
// edge function — para que coincida con la IP que luego consume FFmpeg.
//
// Persistencia: el modo se guarda en `emission_processes.source_mode`
// (misma columna que Teletica/Canal 6). La URL firmada y su expiración
// viven SOLO en memoria (efímeras).
// ───────────────────────────────────────────────────────────────────────
const TELECABLE_API_BASE = 'https://api.srv.teleplus.c.mtvreg.com';
const TELECABLE_UA = 'TPlay_iOS/20260122134025 CFNetwork/3860.600.12 Darwin/25.5.0';
const TELECABLE_CAPABILITIES = 'vast,normalize_id,category,deeplink,carousel,people,lowlatency';
const TELECABLE_PLAYLIST_CAPS = 'adaptive,webvtt,fmp4,vast,clientvast,alerts,carousel,lowlatency';
const TELECABLE_DEFAULT_QUALITY = 40;
const TELECABLE_REFRESH_MARGIN_S = 24 * 3600;        // refrescar URL cuando le queden <24h
const TELECABLE_MIN_RELOGIN_INTERVAL_MS = 20_000;    // anti-abuse rate-limit
// Canales con modo alterno Telecable (login directo VPS, sin túnel CR).
// pid 25 fue el piloto; ampliado a FUTV/Teletica/TDMas1/Canal6/FOX+ tras validación.
// pid '0' (Disney 7) acepta content-id DINÁMICO desde el frontend (dropdown);
// pid '27' (Canal 8 URL) = MULTIMEDIOS y pid '28' (Canal 2 URL) = CDR son
// canales TELECABLE-ONLY (sin modo histórico).
const TELECABLE_PROCESSES = new Set(['0','11','13','14','15','24','25','27','28']);
// Matchers: probamos primero content-id exacto; si no aparece en la playlist,
// caemos a patrones por nombre. Tolerante a renombres del CDN Telecable.
// IDs fijos confirmados por el usuario contra /api/telecable/channels.
const TELECABLE_CHANNEL_MATCHERS = {
  // pid '0' NO tiene matcher fijo: el contentId lo elige el usuario en el
  // dropdown del tab Disney 7 (modo Telecable) y se pasa como override.
  '11': { contentIds: ['FUTV'],        namePatterns: [/^futv$/i] },
  '13': { contentIds: ['TELETICA7'],   namePatterns: [/teletica\s*7/i] },
  '14': { contentIds: ['TDMAS'],       namePatterns: [/^td\s*\+?$/i, /tdm[aá]s/i] },
  '15': { contentIds: ['REPRETEL6'],   namePatterns: [/repretel\s*6/i] },
  '24': { contentIds: ['FOXPLUS'],     namePatterns: [/^fox\+$/i, /fox\s*plus/i] },
  '25': { contentIds: ['FOX'],         namePatterns: [/^fox$/i] },
  '27': { contentIds: ['MULTIMEDIOS'], namePatterns: [/multimedios/i] },
  '28': { contentIds: ['CDR'],         namePatterns: [/^cdr$/i] },
};
// Compat: TELECABLE_CONTENT_MAP se sigue exponiendo (algunos lugares lo leen).
const TELECABLE_CONTENT_MAP = Object.fromEntries(
  Object.entries(TELECABLE_CHANNEL_MATCHERS).map(([pid, m]) => [pid, m.contentIds[0]])
);

// Caché global de la última playlist Telecable resuelta (para /api/telecable/channels).
let lastTelecablePlaylist = { fetchedAt: 0, channels: [] };

const telecableSourceMode = new Map();   // pid → 'scraping' | 'telecable'
const telecableState = new Map();        // pid → { phpsessid, url, expiresAt, contentId, quality, fetchedAt }
const telecableLastReloginAt = new Map();// pid → Date.now() del último relogin (rate-limit)
const telecableFailureCount = new Map(); // pid → count de fallos consecutivos de login
// Perfil de encoding para pids en modo Telecable.
//   'default' → perfil minimal VLC-like (detección por hostname).
//   'disney7' → forzar el perfil AGRESIVO de Disney 7 (max_reload=1000,
//               +genpts, reconnect_at_eof, -re) aunque el hostname sea telecable.
//   Usado por FOX+ URL (pid 24) para el modo "VLC LIKE" (A/B test).
const telecableProfile = new Map();      // pid → 'default' | 'disney7'
const getTelecableProfile = (pid) =>
  (telecableProfile.get(String(pid)) === 'disney7' ? 'disney7' : 'default');
const setTelecableProfile = (pid, profile) => {
  const p = profile === 'disney7' ? 'disney7' : 'default';
  telecableProfile.set(String(pid), p);
  return p;
};

const getFoxSourceMode = (pid) =>
  (telecableSourceMode.get(String(pid)) === 'telecable' ? 'telecable' : 'scraping');
const setFoxSourceMode = (pid, mode) => {
  // Aceptamos 'telecable_vlc' como alias de 'telecable' + profile='disney7'.
  // Cualquier otra cosa se normaliza a 'scraping' + profile='default'.
  const isVlc = mode === 'telecable_vlc';
  const m = (mode === 'telecable' || isVlc) ? 'telecable' : 'scraping';
  telecableSourceMode.set(String(pid), m);
  setTelecableProfile(pid, isVlc ? 'disney7' : 'default');
  const persisted = isVlc ? 'telecable_vlc' : m;
  try {
    if (typeof supabase !== 'undefined' && supabase) {
      supabase
        .from('emission_processes')
        .update({ source_mode: persisted })
        .eq('id', parseInt(String(pid), 10))
        .then(({ error }) => {
          if (error) console.error(`[telecableSourceMode] persist error pid=${pid}:`, error.message);
        });
    }
  } catch (_) {}
  return persisted;
};
const isTelecableMode = (pid) =>
  TELECABLE_PROCESSES.has(String(pid)) && getFoxSourceMode(pid) === 'telecable';
// True si el pid está en Telecable con perfil forzado Disney 7 (VLC LIKE).
const isTelecableVlcMode = (pid) =>
  isTelecableMode(pid) && getTelecableProfile(pid) === 'disney7';
// Aliases con nombre nuevo (más claros). Mantenemos los viejos por compat.
const getTelecableSourceMode = getFoxSourceMode;
const setTelecableSourceMode = setFoxSourceMode;

// Login + playlist + busca canal por content-id. Devuelve URL firmada lista para
// que FFmpeg la consuma. NO se cachea entre procesos: cada pid hace su login
// (10ms a 200ms, suficientemente rápido).
async function telecableLoginAndResolve(processId, contentIdOverride = null, qualityOverride = null) {
  const pid = String(processId);
  const deviceId = process.env.TELECABLE_DEVICE_ID;
  const devicePassword = process.env.TELECABLE_DEVICE_PASSWORD;
  if (!deviceId || !devicePassword) {
    throw new Error('TELECABLE_DEVICE_ID/TELECABLE_DEVICE_PASSWORD no configurados en env');
  }
  const lastAt = telecableLastReloginAt.get(pid) || 0;
  const elapsed = Date.now() - lastAt;
  if (elapsed < TELECABLE_MIN_RELOGIN_INTERVAL_MS) {
    const waitMs = TELECABLE_MIN_RELOGIN_INTERVAL_MS - elapsed;
    await new Promise(r => setTimeout(r, waitMs));
  }
  telecableLastReloginAt.set(pid, Date.now());

  // FUTV URL (11): Telecable rechaza el login desde IP USA (geo-block).
  // Ruteamos SOLO estos 2 fetch por el proxy HTTP del Pi (IP CR residencial),
  // así el token PHPSESSID y la URL firmada quedan atados a IP CR y FFmpeg
  // (que también sale por túnel CR vía isViaCrTunnel) puede consumirlos.
  // Para el resto de pids, dispatcher = undefined → fetch directo desde VPS.
  const teleDispatcher = (pid === '11' && localProxyAgent) ? localProxyAgent : undefined;

  const matcher = TELECABLE_CHANNEL_MATCHERS[pid];
  const explicitContentId = contentIdOverride
    || telecableState.get(pid)?.contentId
    || (matcher && matcher.contentIds[0])
    || TELECABLE_CONTENT_MAP[pid];
  if (!explicitContentId && !matcher) throw new Error(`Sin content-id Telecable para pid=${pid}`);
  const quality = qualityOverride
    || telecableState.get(pid)?.quality
    || TELECABLE_DEFAULT_QUALITY;

  // 1) device-login
  const loginUrl =
    `${TELECABLE_API_BASE}/api/device-login?capabilities=${encodeURIComponent(TELECABLE_CAPABILITIES)}` +
    `&deviceId=${encodeURIComponent(deviceId)}&lang=es&password=${encodeURIComponent(devicePassword)}` +
    `&unit=mastele&version=4.1.0`;
  let loginResp;
  try {
    loginResp = await fetch(loginUrl, {
      headers: { 'User-Agent': TELECABLE_UA, 'Accept': 'application/json' },
      dispatcher: teleDispatcher,
    });
  } catch (e) {
    throw new Error(`telecable login network error: ${e.message}`);
  }
  const loginJson = await loginResp.json().catch(() => ({}));
  if (!loginResp.ok || loginJson?.status !== 1 || !loginJson?.PHPSESSID) {
    throw new Error(`telecable login_failed status=${loginJson?.status} error=${loginJson?.error || loginResp.status}`);
  }
  const phpsessid = loginJson.PHPSESSID;

  // 2) playlist
  const plUrl =
    `${TELECABLE_API_BASE}/api/playlist?logosize=512&format=m3u8` +
    `&capabilities=${encodeURIComponent(TELECABLE_PLAYLIST_CAPS)}` +
    `&quality=${quality}&radioFormat=m3u8&PHPSESSID=${encodeURIComponent(phpsessid)}`;
  const plResp = await fetch(plUrl, {
    headers: {
      'User-Agent': TELECABLE_UA,
      'Accept': 'application/json',
      'Cookie': `PHPSESSID=${phpsessid}; _nss=1`,
    },
    dispatcher: teleDispatcher,
  });
  if (!plResp.ok) throw new Error(`telecable playlist http=${plResp.status}`);
  const plJson = await plResp.json();
  if (plJson?.status !== 1 || !Array.isArray(plJson.channels)) {
    throw new Error(`telecable playlist invalid status=${plJson?.status}`);
  }
  // Cachear playlist para el endpoint /api/telecable/channels (debug/discovery).
  lastTelecablePlaylist = {
    fetchedAt: Math.floor(Date.now() / 1000),
    channels: plJson.channels.map(c => ({
      contentId: c.id,
      name: c.name || c.title || null,
      quality: c.quality || null,
    })),
  };
  // 1) intento por content-id exacto (override → caché → primer candidato del matcher)
  const candidateIds = contentIdOverride
    ? [contentIdOverride]
    : (matcher?.contentIds || [explicitContentId]);
  let channel = null;
  let resolvedContentId = null;
  for (const cid of candidateIds) {
    const found = plJson.channels.find(c => c.id === cid);
    if (found?.url) { channel = found; resolvedContentId = cid; break; }
  }
  // 2) fallback por patrones de nombre
  if (!channel && matcher?.namePatterns?.length) {
    for (const re of matcher.namePatterns) {
      const found = plJson.channels.find(c => {
        const n = (c.name || c.title || '').toString();
        return n && re.test(n);
      });
      if (found?.url) { channel = found; resolvedContentId = found.id; break; }
    }
  }
  if (!channel?.url) {
    throw new Error(`telecable channel not found: tried ${candidateIds.join(',')}${matcher?.namePatterns?.length ? ' + patterns' : ''}`);
  }
  // El CDN de Telecable a veces devuelve una URL "válida" pero apuntando a
  // /error/<lang>/<motivo>/error.m3u8 cuando la geolocalización/IP no está
  // permitida para ese canal (ej. FUTV no autorizado desde IP del VPS).
  // Si dejamos pasar esa URL, FFmpeg se queda en loop sin primer frame.
  // Detectamos el patrón y devolvemos error claro para que el frontend lo muestre.
  if (/\/error\/.+\/error\.m3u8/i.test(channel.url)) {
    const reasonMatch = channel.url.match(/\/error\/[^/]+\/([^/]+)\/error\.m3u8/i);
    const reason = reasonMatch ? reasonMatch[1] : 'unknown';
    throw new Error(`telecable_channel_blocked: contentId=${resolvedContentId} motivo=${reason} (el CDN rechazó este canal para la IP/cuenta actual)`);
  }
  const contentId = resolvedContentId;

  // Extraer expiración del query string de la URL firmada
  let expiresAt = 0;
  try {
    const u = new URL(channel.url);
    expiresAt = parseInt(u.searchParams.get('signature-expiration') || '0', 10);
  } catch (_) { /* opcional */ }

  const state = {
    phpsessid,
    url: channel.url,
    expiresAt,
    contentId,
    quality,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
  telecableState.set(pid, state);
  telecableFailureCount.set(pid, 0);
  return state;
}

// Wrapper que registra fallo + log. Usado por /api/emit y autoRecoverChannel.
// `contentIdOverride` permite que el frontend pase un content-id dinámico
// (caso Disney 7 pid 0, dropdown del usuario).
async function safeTelecableResolve(processId, contentIdOverride = null) {
  try {
    const st = await telecableLoginAndResolve(processId, contentIdOverride, arguments[2] || null);
    sendLog(processId, 'success',
      `📡 Telecable URL obtenida (contentId=${st.contentId}, quality=${st.quality}, expira en ${
        st.expiresAt ? Math.floor((st.expiresAt - Date.now() / 1000) / 3600) + 'h' : '?'
      })`);
    return st;
  } catch (e) {
    const pid = String(processId);
    const failed = (telecableFailureCount.get(pid) || 0) + 1;
    telecableFailureCount.set(pid, failed);
    sendLog(processId, 'error', `❌ Telecable login fallo #${failed}: ${e.message}`);
    throw e;
  }
}

const OUTPUT_PROFILE_STATE_FILE = path.join(__dirname, 'output-profiles.json');
// Perfiles de salida (CBR x264).
//   - preset:      compromiso CPU vs calidad visual (faster ≈ +15% calidad vs veryfast).
//   - x264Params:  ajustes finos de compresión (rc-lookahead/ref/bframes) — solo donde aporta.
//   - audioBitrate: 128k es el "sweet spot"; bajar a 96k apenas ahorra ancho de banda total.
const OUTPUT_PROFILES = {
  passthrough:{ key: 'passthrough',label: 'Passthrough (sin re-encode)', width: '', videoBitrate: '', bufsize: '', audioBitrate: '', preset: '', x264Params: '', passthrough: true },
  normal:     { key: 'normal',     label: 'Normal',     width: '720', videoBitrate: '2000k', bufsize: '4000k', audioBitrate: '128k', preset: 'veryfast', x264Params: '' },
  balanced:   { key: 'balanced',   label: 'Balanceada', width: '540', videoBitrate: '1500k', bufsize: '3000k', audioBitrate: '128k', preset: 'faster',   x264Params: 'rc-lookahead=20:ref=3:bframes=2' },
  optimized:  { key: 'optimized',  label: 'Optimizada', width: '480', videoBitrate: '1200k', bufsize: '2400k', audioBitrate: '128k', preset: 'faster',   x264Params: 'rc-lookahead=20:ref=3:bframes=2' },
};
let outputProfileState = {};
try {
  if (fs.existsSync(OUTPUT_PROFILE_STATE_FILE)) {
    outputProfileState = JSON.parse(fs.readFileSync(OUTPUT_PROFILE_STATE_FILE, 'utf8')) || {};
  }
} catch (err) {
  console.warn('[profiles] No se pudo leer output-profiles.json:', err.message);
}
const normalizeOutputProfile = (profile) => {
  if (profile === 'optimized' || profile === 'balanced' || profile === 'normal' || profile === 'passthrough') return profile;
  return 'normal';
};
const getOutputProfileConfig = (profile) => OUTPUT_PROFILES[normalizeOutputProfile(profile)];
// IDs SRT ingest (16/18/20/21/22/23): default Passthrough (sin re-encode)
// para preservar la calidad exacta de OBS y eliminar CPU/generation-loss.
const SRT_INGEST_DEFAULT_PASSTHROUGH_IDS = new Set(['16','18','20','21','22','23']);
// Canales Telecable HLS de baja prioridad (Canal 8 / Canal 2): el usuario
// los pidió en PASSTHROUGH por defecto para ahorrar CPU del VPS y mantener
// la calidad original (no re-encode). Se permite override desde la UI.
const HLS_DEFAULT_PASSTHROUGH_IDS = new Set(['27','28']);
const getStoredOutputProfile = (processId) => {
  const stored = outputProfileState[String(processId)];
  if (stored) return normalizeOutputProfile(stored);
  if (SRT_INGEST_DEFAULT_PASSTHROUGH_IDS.has(String(processId))) return 'passthrough';
  if (HLS_DEFAULT_PASSTHROUGH_IDS.has(String(processId))) return 'passthrough';
  return 'normal';
};
const saveOutputProfileForProcess = (processId, profile) => {
  const normalized = normalizeOutputProfile(profile);
  outputProfileState[String(processId)] = normalized;
  try { fs.writeFileSync(OUTPUT_PROFILE_STATE_FILE, JSON.stringify(outputProfileState, null, 2)); } catch (_) {}
  return normalized;
};

// ───────────────────────────────────────────────────────────────────────
// TELECABLE persistent state (sobrevive a reinicios). Guardamos por pid:
//   - quality: calidad seleccionada por el usuario en el dropdown UI.
//   - contentId: último contentId resuelto (útil para Disney 7 que es dinámico).
// Se carga al boot y se vuelca a disco en cada cambio.
// ───────────────────────────────────────────────────────────────────────
const TELECABLE_STATE_FILE = path.join(__dirname, 'telecable-state.json');
let telecablePersistedState = {};
try {
  if (fs.existsSync(TELECABLE_STATE_FILE)) {
    telecablePersistedState = JSON.parse(fs.readFileSync(TELECABLE_STATE_FILE, 'utf8')) || {};
  }
} catch (err) {
  console.warn('[telecable] No se pudo leer telecable-state.json:', err.message);
}
function persistTelecableField(pid, field, value) {
  const p = String(pid);
  if (!telecablePersistedState[p]) telecablePersistedState[p] = {};
  telecablePersistedState[p][field] = value;
  try { fs.writeFileSync(TELECABLE_STATE_FILE, JSON.stringify(telecablePersistedState, null, 2)); } catch (_) {}
}
function getPersistedTelecableQuality(pid) {
  const q = telecablePersistedState[String(pid)]?.quality;
  return Number.isFinite(q) ? q : null;
}
function getPersistedTelecableContentId(pid) {
  const c = telecablePersistedState[String(pid)]?.contentId;
  return c || null;
}
// Prime telecableState en memoria con lo persistido. La calidad NO se persiste
// más (Telecable solo entrega una rendition real ≈ q=40); solo conservamos contentId.
for (const [pid, st] of Object.entries(telecablePersistedState)) {
  if (st && st.contentId) {
    telecableState.set(pid, { contentId: st.contentId });
  }
}

// ───────────────────────────────────────────────────────────────────────
// PROXY SOCKS5 (Pi 5 residencial Costa Rica) — usado SOLO para Tigo (ID 12)
// El proxy enruta tanto el scraping (login/token TDMax) como el consumo
// FFmpeg (manifiesto + segmentos HLS) por la IP residencial CR para
// evitar el geobloqueo y la validación de IP del CDN de Tigo.
// ───────────────────────────────────────────────────────────────────────
const TIGO_PROXY_URL = process.env.TIGO_PROXY_URL || 'socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080';
// IDs que requieren scraping local vía Pi5 CR (token/IP deben coincidir).
const PROXY_PROCESSES = new Set(['15', '24', '25']);

// Fallback legado SOCKS/proxychains para FFmpeg. FOX/FOX+ ya NO deben pasar
// por este bloque: el scraping usa proxy HTTP Pi5 y FFmpeg sale por runuser croute.
const LEGACY_SOCKS_FFMPEG_PROCESSES = new Set([]);

// Proxy HTTP en la Pi (tinyproxy) para scraping + FFmpeg de canales que
// requieren IP residencial CR. Topología WireGuard actual:
//   VPS = 10.77.0.2   Pi5 = 10.77.0.1   (verificar con `wg show wg0`)
// El proxy escucha en 10.77.0.1:8888 y sale por la WAN residencial del Pi.
// Usar el proxy evita depender de policy-routing por uid (fwmark/tabla
// cr_routed), que resultó frágil en la combinación kernel+SNAT+conntrack.
const LOCAL_PROXY_URL = process.env.LOCAL_PROXY_URL || 'http://10.77.0.1:8888';
const localProxyAgent = LOCAL_PROXY_URL ? new ProxyAgent(LOCAL_PROXY_URL) : null;

// ───────────────────────────────────────────────────────────────────────
// CR WireGuard Gateway — lista blanca de canales cuyo FFmpeg debe salir
// por el túnel hacia el Pi5 (IP residencial CR). Implementado vía
// `runuser -u croute -- ffmpeg ...`: los paquetes del UID croute reciben
// fwmark 0x77 → tabla cr_routed → wg0. Si el túnel se cae, SOLO estos
// canales fallan; el resto sigue saliendo por la IP del VPS.
// ───────────────────────────────────────────────────────────────────────
// FUTV URL (11) es un caso INVERTIDO: solo entra al túnel cuando el modo es
// Telecable (TDMax funciona directo desde VPS con IP USA). El resto (15/24/25)
// entra al túnel SIEMPRE que no esté en modo Telecable. Ver isViaCrTunnel abajo.
const CHANNELS_VIA_PI_WG = new Set(['11', '15', '24', '25']);
const CR_TUNNEL_USER = 'croute';
const isViaCrTunnel = (pid) => {
  if (!CHANNELS_VIA_PI_WG.has(String(pid))) return false;
  const spid = String(pid);
  const isTele = isTelecableMode(pid);
  // FUTV URL (11): INVERTIDO — solo túnel CR en modo Telecable.
  // En TDMax (oficial), FUTV funciona directo desde VPS USA.
  if (spid === '11') return isTele;
  // 15/24/25: Telecable atado a IP VPS → sale directo. TDMax → túnel CR.
  if (isTele) return false;
  return true;
};
// Wrappea un spawn de ffmpeg cuando el pid debe salir por el túnel CR.
// Estrategia: inyectar `-http_proxy <LOCAL_PROXY_URL>` como opción global de
// FFmpeg (aplica al protocolo HTTP/HTTPS de los inputs HLS). El proxy corre
// en el Pi5 (tinyproxy en 10.77.0.1:8888) y sale por la IP residencial CR.
// No usamos `runuser -u croute` porque el policy-routing por uid + SNAT en
// wg0 rompe conntrack de respuestas TCP en este kernel.
const wrapFfmpegSpawn = (pid, ffmpegArgs) => {
  if (!isViaCrTunnel(pid)) return ['ffmpeg', ffmpegArgs];
  if (!LOCAL_PROXY_URL) return ['ffmpeg', ffmpegArgs];
  return ['ffmpeg', ['-http_proxy', LOCAL_PROXY_URL, ...ffmpegArgs]];
};
// IDs que deben usar la SEGUNDA cuenta TDMax (info@media.cr, la del Raspberry)
// en vez de la cuenta principal (arlopfa). Evita exceder el cupo de devices
// permitidos por TDMax en una sola cuenta.
const PI_ACCOUNT_PROCESSES = new Set(['15', '24', '25', '26']); // segunda cuenta TDMax: CANAL 6 URL, FOX+ URL, FOX URL, FOX+ ALTERNO
const accountForProcess = (pid) => (PI_ACCOUNT_PROCESSES.has(String(pid)) ? 'pi' : 'default');
const getTdmaxCreds = (account) => {
  if (account === 'pi') {
    return {
      email: process.env.TDMAX_EMAIL_PI,
      password: process.env.TDMAX_PASSWORD_PI,
      label: 'SECUNDARIA (info@media.cr)',
    };
  }
  return {
    email: process.env.TDMAX_EMAIL,
    password: process.env.TDMAX_PASSWORD,
    label: 'DEFAULT',
  };
};
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
// Set de pids con un POST /api/emit en vuelo — evita doble spawn por doble click.
const emitInFlight = new Set();

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
          'Referer': TDMAX_APP_REFERER,
          'Origin': TDMAX_APP_ORIGIN,
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
  '20': {
    label: 'CANAL 6 SRT',
    slug: 'Canal6',
    port: parseInt(process.env.CANAL6_SRT_PORT || '9003', 10),
    latencyMs: parseInt(process.env.CANAL6_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.CANAL6_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/canal6-srt-buffer-20',
  },
  '21': {
    label: 'TELETICA SRT',
    slug: 'Teletica',
    port: parseInt(process.env.TELETICA_SRT_PORT || '9004', 10),
    latencyMs: parseInt(process.env.TELETICA_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.TELETICA_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/teletica-srt-buffer-21',
  },
  '22': {
    label: 'FOX+ SRT',
    slug: 'foxmas',
    port: parseInt(process.env.FOXMAS_SRT_PORT || '9005', 10),
    latencyMs: parseInt(process.env.FOXMAS_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.FOXMAS_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/foxmas-srt-buffer-22',
  },
  '23': {
    label: 'FOX SRT',
    slug: 'fox',
    port: parseInt(process.env.FOX_SRT_PORT || '9006', 10),
    latencyMs: parseInt(process.env.FOX_SRT_LATENCY_MS || '2000', 10),
    passphrase: process.env.FOX_SRT_PASSPHRASE || '',
    bufferDir: '/tmp/fox-srt-buffer-23',
  },
};
for (const cfg of Object.values(SRT_INGEST_CONFIGS)) {
  cfg.latencyUs = cfg.latencyMs * 1000;
  cfg.bufferPlaylist = path.join(cfg.bufferDir, 'buf.m3u8');
  cfg.minSegments = 3;
  cfg.waitTimeoutMs = 60000;
  // Puerto UDP local (loopback) donde srt-live-transmit reenvía el SRT.
  // Convención: puerto SRT + 1000 (9000→10000, 9005→10005, etc.).
  cfg.udpPort = cfg.port + 1000;
}
const isSrtIngestProcess = (process_id) => Object.prototype.hasOwnProperty.call(SRT_INGEST_CONFIGS, String(process_id));
const getSrtConfig = (process_id) => SRT_INGEST_CONFIGS[String(process_id)];
const PI_SRT_INGEST_PROCESSES = new Set(['21', '22', '23']);

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

// ─────────────────────────────────────────────────────────────────────
// LIVE STATS (telemetría en tiempo real por proceso, expuesta en /api/status)
// Parsea progress de FFmpeg (frame/fps/bitrate/speed/drop/dup/q) y, cuando
// la línea viene de srt-live-transmit, también RTT/BW/lost del enlace SRT.
// Sirve para el tab "Uptime" del dashboard: ver cómo está llegando la señal
// de OBS/Pearl en vivo, detectar degradación inmediata.
// ─────────────────────────────────────────────────────────────────────
const liveStats = new Map(); // Map<process_id, { bitrateKbps, fps, frame, speed, drop, dup, q, srtRttMs, srtBwMbps, srtPktsLost, updatedAt }>

const updateLiveStats = (process_id, line) => {
  if (!line) return;
  const key = String(process_id);
  const prev = liveStats.get(key) || {};
  const patch = {};
  let m;
  if ((m = line.match(/\bbitrate=\s*([\d.]+)kbits\/s/))) patch.bitrateKbps = Math.round(parseFloat(m[1]));
  if ((m = line.match(/\bfps=\s*([\d.]+)/))) patch.fps = parseFloat(m[1]);
  if ((m = line.match(/\bframe=\s*(\d+)/))) patch.frame = parseInt(m[1], 10);
  if ((m = line.match(/\bspeed=\s*([\d.]+)x/))) patch.speed = parseFloat(m[1]);
  if ((m = line.match(/\bdrop=\s*(\d+)/))) patch.drop = parseInt(m[1], 10);
  if ((m = line.match(/\bdup=\s*(\d+)/))) patch.dup = parseInt(m[1], 10);
  if ((m = line.match(/\bq=\s*(-?[\d.]+)/))) patch.q = parseFloat(m[1]);
  // Métricas del enlace SRT (srt-live-transmit imprime tipo "SRT.cn:RTT: 95ms", "bw: 5.2Mbps", "lost: 3")
  if ((m = line.match(/RTT[\s:=]+([\d.]+)/i))) patch.srtRttMs = parseFloat(m[1]);
  if ((m = line.match(/\bbw[\s:=]+([\d.]+)\s*Mbps/i))) patch.srtBwMbps = parseFloat(m[1]);
  else if ((m = line.match(/\bBW[\s:=]+([\d.]+)/))) patch.srtBwMbps = parseFloat(m[1]);
  if ((m = line.match(/\blost[\s:=]+(\d+)/i))) patch.srtPktsLost = (prev.srtPktsLost || 0) + parseInt(m[1], 10);
  if (Object.keys(patch).length === 0) return;
  liveStats.set(key, { ...prev, ...patch, updatedAt: Date.now() });
};

const clearLiveStats = (process_id) => liveStats.delete(String(process_id));

const getLiveStats = (process_id) => {
  const s = liveStats.get(String(process_id));
  if (!s) return null;
  // Considerar stale si no se actualiza en >30s (proceso terminado o congelado)
  if (Date.now() - (s.updatedAt || 0) > 30000) return null;
  return s;
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

// ── Preflight de puerto SRT (UDP) ─────────────────────────────────
// Detecta procesos huérfanos (ffmpeg/srt-live-transmit) que retengan el
// bind del puerto y los mata con SIGKILL para que el listener nuevo pueda
// hacer bind. Sin esto, FFmpeg muere a los 2s con "Input/output error".
const ensureSrtPortFree = (port, process_id, label) => {
  if (!port) return;
  const log = (lvl, msg) => {
    try { if (typeof sendLog === 'function' && process_id != null) sendLog(process_id, lvl, msg); } catch (_) {}
    try { console.log(`[srt-preflight:${label || port}] ${msg}`); } catch (_) {}
  };
  let pids = [];
  try {
    const out = execSync(`lsof -tiUDP:${port} 2>/dev/null || true`, { encoding: 'utf8' });
    pids = out.split(/\s+/).map(s => s.trim()).filter(Boolean);
  } catch (_) { pids = []; }
  if (pids.length === 0) return;
  for (const pid of pids) {
    let cmd = '';
    try { cmd = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, { encoding: 'utf8' }).trim(); } catch (_) {}
    const isOurs = /ffmpeg|srt-live-transmit/i.test(cmd);
    if (isOurs) {
      log('warn', `🧹 Puerto UDP ${port} ocupado por PID ${pid} (huérfano: ${cmd.slice(0,80)}). Matando con SIGKILL.`);
      try { execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); } catch (_) {}
    } else {
      log('error', `⛔ Puerto UDP ${port} ocupado por PID ${pid} ajeno (${cmd.slice(0,80) || 'desconocido'}). Liberá manualmente.`);
    }
  }
  // Pausa breve para que el kernel libere el bind.
  try { execSync('sleep 0.5', { stdio: 'ignore' }); } catch (_) {}
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

// ─────────────────────────────────────────────────────────────────────
// SRT INGEST ARCHITECTURE (IDs 12/16/18/20/21/22/23)
//
// El listener SRT (srt-live-transmit) corre PERMANENTE como proceso
// independiente del FFmpeg ETAPA 2. Reenvía el SRT a UDP local
// (127.0.0.1:<udpPort>). Cuando el Raspberry/OBS se reconecta (p.ej.
// rotación de token cada 60s), srt-live-transmit absorbe la
// reconexión sin matar al FFmpeg que lee UDP — así el HLS buffer y
// toda la cadena downstream no se reinician.
//
// Pi/OBS (SRT caller) → srt-live-transmit (listener persistente)
//                     → udp://127.0.0.1:<udpPort>
//                     → ffmpeg ETAPA 2 (lee UDP, escribe HLS buffer)
// ─────────────────────────────────────────────────────────────────────

// Map<process_id, ChildProcess> para los listeners srt-live-transmit
// persistentes. Sobreviven a los reinicios del ffmpeg ETAPA 2.
const srtListenerProcesses = new Map();

const buildSrtListenerUrl = (cfg) => {
  // srt-live-transmit URI: `latency` es en MILISEGUNDOS (no μs).
  // Buffers grandes (rcvbuf 64MB) + fc amplio para tolerar picos de jitter
  // de internet residencial (medidos hasta 250ms en pings de 1316 bytes).
  let url = `srt://:${cfg.port}?mode=listener&latency=${cfg.latencyMs}&rcvbuf=67108864&fc=52428&pkt_size=1316`;
  if (cfg.passphrase && cfg.passphrase.length >= 10) {
    url += `&pbkeylen=16&passphrase=${encodeURIComponent(cfg.passphrase)}`;
  }
  return url;
};

// Levanta (o reutiliza) el srt-live-transmit listener para un process_id.
// Idempotente: si ya hay uno vivo, no hace nada.
const ensureSrtListener = (process_id) => {
  const key = String(process_id);
  const existing = srtListenerProcesses.get(key);
  if (existing && !existing.killed && existing.exitCode === null) return existing;

  const cfg = getSrtConfig(process_id);
  if (!cfg) throw new Error(`No SRT config for process_id=${process_id}`);

  // Preflight: liberar el puerto SRT si hay procesos huérfanos.
  ensureSrtPortFree(cfg.port, process_id, cfg.label || `SRT ${process_id}`);

  const srtUrl = buildSrtListenerUrl(cfg);
  const udpUrl = `udp://127.0.0.1:${cfg.udpPort}?pkt_size=1316`;

  const args = [srtUrl, udpUrl, '-loglevel:info', '-stats-report-frequency:5000'];
  const proc = spawn('srt-live-transmit', args);
  srtListenerProcesses.set(key, proc);

  proc.stderr?.on('data', (buf) => {
    const txt = buf.toString();
    // Parsear métricas del enlace SRT (RTT, BW, lost) hacia liveStats.
    // srt-live-transmit imprime cada ~5s con -stats-report-frequency:5000.
    for (const l of txt.split('\n')) {
      if (/RTT|BW|bw|lost/i.test(l)) updateLiveStats(process_id, l);
    }
    // Solo logueamos handshakes/errores reales para no saturar.
    // Filtramos métricas periódicas SRT (RcvQ/SndQ/SRT.cn/etc) que sólo ruidean.
    if (/SRT:RcvQ|SRT:SndQ|SRT\.cn|RTT=|BW=/i.test(txt)) return;
    if (/(error|fail|reject|disconnect|accept|connect)/i.test(txt)) {
      const line = txt.split('\n').find(l => l.trim()) || txt.trim();
      sendLog(process_id, /error|fail|reject/i.test(line) ? 'warn' : 'info',
        `🛰️ slt: ${line.substring(0, 200)}`);
    }
  });

  proc.on('exit', (code, signal) => {
    srtListenerProcesses.delete(key);
    if (manualStopProcesses.has(key) || manualStopProcesses.has(Number(key))) {
      sendLog(process_id, 'info', `🛰️ srt-live-transmit detenido por parada manual`);
      return;
    }
    sendLog(process_id, 'warn',
      `🛰️ srt-live-transmit cayó (code=${code ?? '-'}${signal ? `, signal=${signal}` : ''}). Reabriendo listener en 2s...`);
    setTimeout(() => {
      if (manualStopProcesses.has(key) || manualStopProcesses.has(Number(key))) return;
      try { ensureSrtListener(process_id); }
      catch (e) { sendLog(process_id, 'error', `❌ No se pudo reabrir srt-live-transmit: ${e.message}`); }
    }, 2000);
  });

  sendLog(process_id, 'success',
    `🛰️ Listener persistente UP: srt://:${cfg.port} → udp://127.0.0.1:${cfg.udpPort} (latency=${cfg.latencyMs}ms)`);
  return proc;
};

const stopSrtListener = (process_id) => {
  const key = String(process_id);
  const proc = srtListenerProcesses.get(key);
  srtListenerProcesses.delete(key);
  if (proc && !proc.killed) {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
};

// ETAPA 2: FFmpeg lee del UDP local (alimentado por srt-live-transmit) y
// escribe el buffer HLS. Este proceso NO ve las desconexiones del caller SRT:
// UDP es sin conexión y srt-live-transmit absorbe los reconnects.
const startSrtIngest = (process_id) => {
  const cfg = getSrtConfig(process_id);
  if (!cfg) throw new Error(`No SRT config for process_id=${process_id}`);

  // ─────────────────────────────────────────────────────────────────
  // ARQUITECTURA SRT INGEST (May 2026): UN SOLO FFMPEG por canal.
  // FFmpeg actúa simultáneamente como SRT listener (input) y como
  // encoder HLS final (output). Antes había 3 procesos por canal
  // (srt-live-transmit → udp → ffmpeg buffer → ffmpeg ETAPA 2),
  // y la cascada de muertes parciales causaba caídas de 30-90 min
  // tanto al Pearl Nano como al Raspberry. Ahora es 1 solo proceso:
  // si cae, reinicia limpio y el Caller (Pearl/Pi/OBS) reconecta solo.
  // ─────────────────────────────────────────────────────────────────

  ensureSrtPortFree(cfg.port, process_id, cfg.label || `SRT ${process_id}`);

  const slug = HLS_SLUG_MAP[process_id] || `stream_${process_id}`;
  const outDir = path.join(HLS_OUTPUT_DIR, slug);
  // Wipe agresivo de la carpeta HLS (mismo patrón que isHlsOutput, evita
  // que XUI sirva un manifest con segmentos viejos mezclados con timestamps
  // nuevos tras un recovery).
  try {
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  } catch (_) {}
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}

  // Matar residuales sobre este puerto/output (defensa en profundidad).
  try {
    const patterns = [`srt://0.0.0.0:${cfg.port}`, `live/${slug}/`];
    for (const pat of patterns) {
      try { execSync(`pkill -9 -f ${JSON.stringify(pat)}`, { stdio: 'ignore' }); } catch (_) {}
    }
  } catch (_) {}
  resetTigoSrtMetric(process_id);

  // Perfil de encoding (mismo helper que el resto del sistema usa).
  const stageProfile = getOutputProfileConfig(getStoredOutputProfile(process_id));
  const isPassthrough = !!stageProfile.passthrough;
  const vBitrate = stageProfile.videoBitrate;
  const vBufsize = stageProfile.bufsize;
  const vHeight = stageProfile.width;
  const aBitrate = stageProfile.audioBitrate;
  const vPreset  = stageProfile.preset || 'veryfast';
  // FPS estándar para todas las fuentes externas (Pearl/OBS/Pi están
  // configuradas a 29.97 o 30; CFR + -r 30 alinea cualquier variación).
  const srtFps = '30';
  const srtGop = '60';

  // SRT listener: latency configurable por canal (default 2000ms).
  // ⚠️ FFmpeg `srt://` interpreta `latency` en MICROSEGUNDOS — antes mandábamos
  // cfg.latencyMs (2000) y FFmpeg lo leía como 2ms (¡no 2 segundos!), por eso
  // cualquier jitter >2ms causaba pausas. Ahora usamos latencyUs (= ms*1000).
  // Sumamos rcvbuf 64MB y fc 52428 para absorber ráfagas de retransmisión SRT
  // en redes residenciales con picos de jitter (hasta 250ms medidos).
  let srtInput = `srt://0.0.0.0:${cfg.port}?mode=listener&latency=${cfg.latencyUs}&rcvbuf=67108864&fc=52428&pkt_size=1316`;
  if (cfg.passphrase && cfg.passphrase.length >= 10) {
    srtInput += `&pbkeylen=16&passphrase=${encodeURIComponent(cfg.passphrase)}`;
  }

  const outPlaylist = path.join(outDir, 'playlist.m3u8');
  const encodeArgs = [
    '-hide_banner',
    '-loglevel', 'verbose',
    '-stats',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-analyzeduration', '3000000',
    '-probesize', '2000000',
    '-i', srtInput,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', vPreset,
    '-profile:v', 'main',
    '-threads', '4',
    '-b:v', vBitrate,
    '-maxrate', vBitrate,
    '-bufsize', vBufsize,
    ...(stageProfile.x264Params ? ['-x264-params', stageProfile.x264Params] : []),
    '-vf', `scale=-2:${vHeight}`,
    '-r', srtFps,
    '-vsync', 'cfr',
    '-g', srtGop,
    '-keyint_min', srtGop,
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', aBitrate,
    '-ar', '48000',
    '-max_muxing_queue_size', '1024',
    '-reset_timestamps', '1',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    '-hls_allow_cache', '1',
    '-hls_start_number_source', 'epoch',
    outPlaylist,
  ];
  // PASSTHROUGH: sólo remux SRT → HLS, sin tocar codec/bitrate/resolución.
  // Lo que manda OBS llega idéntico al cliente. CPU ~3% por canal y cero
  // generation loss. Requiere que OBS mande H264+AAC (caso estándar).
  // hls_time=6 para alinear con keyframes de OBS (típico 2s) — segmento
  // arranca en keyframe natural sin -force_key_frames.
  const passthroughArgs = [
    '-hide_banner',
    '-loglevel', 'verbose',
    '-stats',
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    '-analyzeduration', '3000000',
    '-probesize', '2000000',
    '-i', srtInput,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-bsf:v', 'h264_mp4toannexb',
    '-max_muxing_queue_size', '1024',
    '-reset_timestamps', '1',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    '-hls_allow_cache', '1',
    '-hls_start_number_source', 'epoch',
    outPlaylist,
  ];
  const args = isPassthrough ? passthroughArgs : encodeArgs;

  const proc = spawn('ffmpeg', args);
  updateTigoSrtMetric(process_id, { connected: false, since: Date.now() });
  cfg._lastProfile = isPassthrough
    ? 'PASSTHROUGH (copy v+a, sin re-encode)'
    : `${vHeight}p CBR ${vBitrate} @ ${srtFps}fps preset=${vPreset}`;
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
  // Preflight: liberar puerto si quedó un FFmpeg huérfano del SRT listener anterior.
  ensureSrtPortFree(TIGO_SRT_PORT, process_id, 'TIGO HDMI');
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
    // Fase 2: alineado con startSrtIngest (3s/2MB). El stream MPEG-TS
    // del Pi5 expone SPS/PPS muy rápido; 10s era exceso heredado.
    '-analyzeduration', '3000000',
    '-probesize', '2000000',
    '-i', srtUrl,
    // CRÍTICO: mapear EXPLÍCITAMENTE video y audio. Sin esto FFmpeg
    // a veces descarta el video cuando llega como "unspecified size".
    '-map', '0:v:0',
    '-map', '0:a:0',
    // Re-encodeamos audio (mismo motivo que startSrtIngest): el SRT del
    // Pi5 puede no exponer sample_rate al inicio y rompe "-c copy" con
    // "Sample rate not set". Video sigue en copy (cero CPU).
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '128k',
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

  // Si hay proxy HTTP configurado (tinyproxy en la Pi), usarlo en lugar del
  // bind directo a WireGuard. Más estándar, más fácil de debuggear.
  if (localProxyAgent) {
    sendLog('system', 'info', `🌐 Scraping vía proxy HTTP Pi5: ${LOCAL_PROXY_URL.replace(/:\/\/([^:@]+):[^@]+@/, '://$1:***@')}`);
    return undiciRequest(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      dispatcher: localProxyAgent,
      signal: options.signal,
    }).then(({ statusCode, headers: uHeaders, body }) => {
      const setCookie = uHeaders['set-cookie'];
      return {
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode || 0,
        headers: {
          get: (name) => {
            const value = uHeaders[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : (value ?? null);
          },
          getSetCookie: () => Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []),
        },
        text: () => body.text(),
        json: () => body.json(),
      };
    });
  }

  // Fallback legacy: bind directo a la IP local WireGuard del VPS.
  // Debe evitarse en producción; si falla con EADDRNOTAVAIL, configurar/usar
  // LOCAL_PROXY_URL=http://10.77.0.1:8888 (proxy HTTP del Pi5).
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: getProxyAgent(),
      localAddress: '10.77.0.2',
      family: 4,
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
// ID 19 (RANDOM Disney 7) incluido: usa la misma URL/CDN que Disney 7 (ID 0),
// necesita el mismo analyzeduration=3s/probesize=2MB para parsear correctamente
// HLS multi-variante (TUDN, etc.).
const STABLE_SOURCE_PROCESSES = new Set(['0', '5', '10', '15', '19']);
// Fuentes que usan -re (lectura a tasa nativa) — TODOS los canales lo necesitan
// Sin -re, FFmpeg lee a velocidad CPU (70-100fps), agota los segmentos HLS y causa EOF prematuro
const RE_FLAG_PROCESSES = new Set(['0', '1', '3', '4', '5', '6', '10', '11', '13', '14', '15']);
// Procesos con cadencia CFR (vsync cfr + 29.97fps) - canales de emisión EXCEPTO Disney 7 (TUDN)
// Disney 7 (ID 0) usa valores enteros (30fps/GOP60) porque el servidor RTMP destino
// rechaza conexiones con GOP decimal (59.94) causando Broken pipe a los ~120s.
// Canal 6 (5/15) entrega 30fps reales: si se fuerza CFR debe ser a 30/GOP60, nunca 29.97.
const CFR_OUTPUT_PROCESSES = new Set(['1', '3', '4', '6', '10', '11', '13', '14']);

// Fallback URLs oficiales por canal (se usan si el scraping falla)
const CHANNEL_FALLBACK_URLS = {
  '6': 'https://mdstrm.com/live-stream-playlist/5a7b1e63a8da282c34d65445.m3u8', // Multimedios oficial
  '15': 'https://d2qsan2ut81n2k.cloudfront.net/live/02f0dc35-8fd4-4021-8fa0-96c277f62653/ts:abr.m3u8', // Canal 6 oficial Repretel
};

    const TDMAX_CDN_BLOCKED_PROCESSES = new Set(['24', '25', '26']);

    // Track de intentos de recovery para saber cuándo usar fallback
const recoveryAttempts = new Map(); // Map<processId, number>


// Cache de sesión de scraping: guarda cookies + accessToken para pasarlos a FFmpeg
// Esto es CRÍTICO para Tigo cuyo CDN valida cookies/token junto con la IP
const scrapeSessionCache = new Map(); // Map<processId, { cookies, accessToken, timestamp }>

// Control de retry rápido para evitar loops cuando la misma URL vuelve a caer enseguida
const quickRetryState = new Map(); // Map<processId, lastQuickRetryTimestampMs>
const isProcessManuallyStopped = (processId) => {
  const key = String(processId);
  const numeric = Number(key);
  return manualStopProcesses.has(key) || (Number.isFinite(numeric) && manualStopProcesses.has(numeric));
};
const markProcessManuallyStopped = (processId) => {
  const key = String(processId);
  const numeric = Number(key);
  manualStopProcesses.add(key);
  if (Number.isFinite(numeric)) manualStopProcesses.add(numeric);
  autoRecoveryInProgress.set(key, false);
  for (let i = recoveryQueue.length - 1; i >= 0; i--) {
    if (recoveryQueue[i]?.processId === key) recoveryQueue.splice(i, 1);
  }
  quickRetryState.delete(key);
  if (Number.isFinite(numeric)) quickRetryState.delete(numeric);
  recoveryAttempts.delete(key);
  scrapeSessionCache.delete(key);
  if (Number.isFinite(numeric)) scrapeSessionCache.delete(numeric);
  detectedErrors.delete(key);
  resetCircuitBreaker(key);
};
// Canales scrapeados desde TDMax con wmsAuthSign de vida corta:
// FUTV URL (11), Teletica URL (13), TDMAS 1 URL (14), FOX+ URL (24) y FOX URL (25).
// Si caen tras horas, reusar la misma URL solo provoca 403/404/stall. Deben ir
// directo a scraping fresco para obtener token + cookies nuevos.
const QUICK_RETRY_DISABLED_PROCESSES = new Set(['11', '13', '14', '24', '25']);

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
const lastFrameNumber = new Map(); // Map<processId, number> — último contador de frames (detectar stall real)
const lastProgressLog = new Map(); // Map<processId, timestampMs> — throttle de logs de progreso
const PROGRESS_LOG_INTERVAL = 5000; // Loguear progreso cada 5 segundos

// ─── SALUD DE STREAMS (fps instantáneo, severidad de gaps, resumen 60s) ─────
// Reemplaza el fps acumulado (engañoso) por métricas en vivo. Se aplica a
// TODOS los procesos (Disney, TDMax, Telecable, SRT, archivos, etc.).
// Ventana ancha (90s) para suavizar micro-stalls del encoder cuando la fuente
// hace pausas breves (reload de sub-playlist HLS, cambio de nimblesessionid,
// jitter de CDN). FFmpeg congela el frame counter durante el stall y luego
// dispara en ráfaga para recuperar → el promedio real sigue siendo ~30fps
// pero una ventana corta (30s) mostraba 1.2 fps o 69 fps engañosos.
const HEALTH_WINDOW_MS = 90_000;          // ventana para fps "instantáneo" suavizado
const HEALTH_SUMMARY_INTERVAL_MS = 60_000; // "SALUD 60s"
const HEALTH_BUFFER_MS = 150_000;         // guardar samples 150s hacia atrás
const HEALTH_SKIP_THRESHOLD = 200;        // Δframe > 200 en <5s = FFmpeg saltó segmentos
const HEALTH_SKIP_WINDOW_MS = 5_000;
// Umbrales fps (30fps nominal): sano ≥22, inestable 12-22, degradado <12.
// Bajados porque con ventana 90s solo debería marcar problemas sostenidos.
const HEALTH_FPS_OK = 22;
const HEALTH_FPS_WARN = 12;
// Cap de fps mostrado: ráfagas de catch-up (>45fps sobre nominal 30) no son
// una "buena señal", son recuperación de un stall. Las cap-eamos para no
// mostrar picos de 58/69 fps que confunden.
const HEALTH_FPS_DISPLAY_CAP = 45;
// samples: Array<{t: ms, frame: number}> por pid
// gaps: Array<ms> — timestamps de gaps detectados
// skips: Array<{t, delta}>
// lastSummaryAt: ms — última vez que se emitió "SALUD 60s"
const streamHealth = new Map();

function _getHealth(pid) {
  const key = String(pid);
  let h = streamHealth.get(key);
  if (!h) {
    h = { samples: [], gaps: [], skips: [], lastSummaryAt: 0, lastFrame: null };
    streamHealth.set(key, h);
  }
  return h;
}

function healthRecordFrame(pid, frameNum) {
  if (frameNum === null || frameNum === undefined || isNaN(frameNum)) return;
  const h = _getHealth(pid);
  const now = Date.now();
  // Detectar skip (FFmpeg saltó segmentos): Δframe grande en ventana corta
  if (h.lastFrame !== null) {
    const recent = h.samples.filter(s => now - s.t <= HEALTH_SKIP_WINDOW_MS);
    if (recent.length > 0) {
      const oldest = recent[0];
      const delta = frameNum - oldest.frame;
      const dt = (now - oldest.t) / 1000;
      // >200 frames en <5s con fps aparente >60 = skip forward
      if (delta > HEALTH_SKIP_THRESHOLD && dt > 0 && (delta / dt) > 60) {
        h.skips.push({ t: now, delta });
      }
    }
  }
  h.lastFrame = frameNum;
  h.samples.push({ t: now, frame: frameNum });
  // Trim buffer
  const cutoff = now - HEALTH_BUFFER_MS;
  while (h.samples.length > 0 && h.samples[0].t < cutoff) h.samples.shift();
  while (h.gaps.length > 0 && h.gaps[0] < cutoff) h.gaps.shift();
  while (h.skips.length > 0 && h.skips[0].t < cutoff) h.skips.shift();
}

function healthRecordGap(pid) {
  const h = _getHealth(pid);
  h.gaps.push(Date.now());
}

function healthComputeFps(pid, windowMs = HEALTH_WINDOW_MS) {
  const h = _getHealth(pid);
  const now = Date.now();
  const cutoff = now - windowMs;
  const inWin = h.samples.filter(s => s.t >= cutoff);
  if (inWin.length < 2) return null;
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  // Necesitamos al menos ~20s de datos reales para que el promedio sea
  // representativo. Con menos, devolvemos null → estado "⏳ MIDIENDO".
  if (dt < 20) return null;
  const raw = Math.max(0, (last.frame - first.frame) / dt);
  // Cap ráfagas de catch-up para no reportar 58/69fps engañosos.
  return Math.min(raw, HEALTH_FPS_DISPLAY_CAP);
}

function healthStatus(fps) {
  if (fps === null) return { emoji: '⏳', label: 'MIDIENDO' };
  if (fps >= HEALTH_FPS_OK) return { emoji: '✅', label: 'SANO' };
  if (fps >= HEALTH_FPS_WARN) return { emoji: '🟡', label: 'INESTABLE' };
  return { emoji: '🔴', label: 'DEGRADADO' };
}

// Severidad de un gap basado en cuánto tiempo el fps instantáneo estuvo bajo
// antes del gap. Aproximación: usar fps últimos 15s.
function healthGapSeverity(pid) {
  const fps15 = healthComputeFps(pid, 15_000);
  const fps5 = healthComputeFps(pid, 5_000);
  const worst = Math.min(fps15 ?? 30, fps5 ?? 30);
  if (worst < 5) return { emoji: '🔴', label: 'GRAVE', hint: 'reload probable en TV' };
  if (worst < 15) return { emoji: '🟠', label: 'MEDIO', hint: 'freeze breve posible' };
  return { emoji: '🟢', label: 'LEVE', hint: 'invisible en TV' };
}

function healthFormatProgress(pid, frameNum, ffmpegFpsStr, bitrateStr) {
  // Preferir el fps que reporta FFmpeg directamente: es promedio acumulado
  // desde el inicio y refleja la salud real sin amplificar micro-stalls.
  // Nuestro cálculo por deltas se usa SOLO como confirmación del estado.
  const ffmpegFps = ffmpegFpsStr != null ? parseFloat(ffmpegFpsStr) : NaN;
  const ourFps = healthComputeFps(pid);
  // Estado: si ambos coinciden en "malo", marcamos degradado. Si FFmpeg
  // reporta sano pero nosotros vemos un dip transitorio, confiamos en FFmpeg.
  const fpsForStatus = !isNaN(ffmpegFps) ? ffmpegFps : ourFps;
  const st = healthStatus(fpsForStatus);
  const fpsTxt = !isNaN(ffmpegFps)
    ? ffmpegFps.toFixed(1)
    : (ourFps === null ? '—' : ourFps.toFixed(1));
  const parts = [
    `Progreso: frame=${frameNum}`,
    `fps=${fpsTxt}`,
    `${st.emoji} ${st.label}`,
  ];
  if (bitrateStr) parts.push(`bitrate=${bitrateStr}`);
  return parts.join(' | ');
}

// Emite "SALUD 60s" por cada proceso activo. Se llama por interval global.
function healthEmitSummaries() {
  const now = Date.now();
  for (const [pid, status] of emissionStatuses.entries()) {
    if (status !== 'running') continue;
    const h = _getHealth(pid);
    if (h.samples.length < 2) continue;
    if (now - h.lastSummaryAt < HEALTH_SUMMARY_INTERVAL_MS - 1000) continue;
    h.lastSummaryAt = now;
    const fps60 = healthComputeFps(pid, 60_000);
    const st = healthStatus(fps60);
    const gaps60 = h.gaps.filter(t => now - t <= 60_000).length;
    const skips60 = h.skips.filter(s => now - s.t <= 60_000).length;
    const fpsTxt = fps60 === null ? '—' : fps60.toFixed(1);
    sendLog(pid, 'info',
      `📊 SALUD últimos 60s: fps_real=${fpsTxt} ${st.emoji} | gaps=${gaps60} | skips=${skips60} | ${st.label}`
    );
  }
}
setInterval(() => { try { healthEmitSummaries(); } catch (e) { console.error('healthEmitSummaries:', e); } }, 15_000);
// ─── FIN SALUD DE STREAMS ───────────────────────────────────────────────────

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

      if (['24', '25'].includes(String(processId)) && CHANNEL_MAP[String(processId)]) {
        const { channelId, channelName } = CHANNEL_MAP[String(processId)];
        ignoredLateCloseProcesses.add(processData.process);
        ffmpegProcesses.delete(processId);
        lastFrameTime.delete(processId); lastFrameNumber.delete(processId);
        emissionStatuses.set(processId, 'idle');
        scrapeSessionCache.delete(String(processId));
        quickRetryState.delete(String(processId));
        enqueueRecovery(processId, async () => {
          await sleep(1500);
          if (manualStopProcesses.has(String(processId)) || manualStopProcesses.has(Number(processId))) {
            sendLog(processId, 'info', `🛑 Recovery FOX cancelado: parada manual detectada`);
            return;
          }
          sendLog(processId, 'warn', `🦊 ${channelName}: arranque colgado, forzando scraping fresco inmediato`);
          await autoRecoverChannel(String(processId), channelId, channelName);
        });
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
      : isSrtIngestProc
      ? 180000  // SRT ingest (IDs 21/22/23): tolerar ciclo completo Pi5 (stall TDMax + re-login + reanudación SRT con latency 8s) sin matar ETAPA 2
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
      
      lastFrameTime.delete(processId); lastFrameNumber.delete(processId);
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

// Device-id determinístico por process_id.
// Mantiene SIEMPRE el mismo UUID por canal (no crece con re-logins / recoveries),
// para que TDMax cuente cada canal como UN dispositivo estable y los 3 canales
// de arlopfa (FUTV, TDmas 1, Teletica) no se invaliden mutuamente al re-loguear
// (cross-invalidation cuando comparten un mismo device-id global).
// Si no hay process_id (llamadas legacy), cae al UUID fijo anterior.
const getDeviceIdForProcess = (pid) => {
  if (pid === undefined || pid === null || pid === '') return FIXED_DEVICE_ID;
  const hash = crypto.createHash('sha1').update(`tdmax-device-v1-${pid}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
};

// Scraping LOCAL (directo desde el VPS) — el token se genera con la IP del VPS
// así el CDN valida correctamente la IP que hace el request de video.
// Si useProxy=true, todo el tráfico (login + token) sale por el SOCKS5 del Pi 5
// para que el token quede vinculado a la IP residencial CR (caso Tigo).
const scrapeStreamUrlLocal = async (channelId, channelName, { useProxy = false, account = 'default', processId = null } = {}) => {
  const tag = useProxy ? 'LOCAL via Pi5 (CR)' : 'LOCAL';
  const { email, password, label: accountLabel } = getTdmaxCreds(account);
  const deviceId = getDeviceIdForProcess(processId);
  const deviceTag = processId !== null && processId !== undefined ? ` device:${deviceId.slice(0,8)}` : '';
  const logTarget = processId !== null && processId !== undefined ? processId : 'system';
  sendLog(logTarget, 'info', `🔄 Scraping ${tag} ${channelName} [cuenta ${accountLabel}${deviceTag}]: obteniendo URL...`);

  if (!email || !password) {
    const envVars = account === 'pi' ? 'TDMAX_EMAIL_PI / TDMAX_PASSWORD_PI' : 'TDMAX_EMAIL / TDMAX_PASSWORD';
    return { url: null, error: `Credenciales TDMAX no configuradas en el VPS (${envVars})` };
  }
  
  try {
    // Paso 1: Login — capturar cookies de la respuesta
    const loginResp = await fetchWithOptionalProxy(`${STREANN_BASE_URL}/web/services/v3/external/login?r=${STREANN_RESELLER_ID}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': TDMAX_WEB_USER_AGENT,
        'Origin': TDMAX_APP_ORIGIN,
        'Referer': TDMAX_APP_REFERER,
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
    // TDMax cambió el contrato del loadbalancer en mayo 2026: ahora valida los
    // nombres exactos usados por su web app (`device-id`, `access_token`, etc.).
    // Los nombres anteriores camelCase devuelven code 628: "redirect url is null".
    const lbParams = new URLSearchParams({
      r: STREANN_RESELLER_ID,
      'device-id': deviceId,
      access_token: accessToken,
      country_code: 'CR',
      doNotUseRedirect: 'true',
      'device-name': processId !== null && processId !== undefined ? `web-p${processId}` : 'web',
      'device-type': 'web',
    });
    const lbUrl = `${STREANN_BASE_URL}/loadbalancer/services/v1/channels-secure/${channelId}/playlist.m3u8?${lbParams.toString()}`;
    
    const lbHeaders = {
      'User-Agent': TDMAX_WEB_USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
      'Origin': TDMAX_APP_ORIGIN,
      'Referer': TDMAX_APP_REFERER,
      'Authorization': `Bearer ${accessToken}`,
      // Headers del cliente oficial TDMax (mayo 2026). Sin ellos el
      // loadbalancer responde code 628 "redirect url is null or empty 1".
      'x-app-name': 'TDMAX',
      'x-app-platform': 'web',
      'x-app-version': '3.1.1',
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

    // Rechazar placeholders/VOD ("canal no disponible") en vez de aceptarlos
    // como señal live. TDMax puede devolver dominios o rutas de slate/offline.
    if (/(cfvod\.streann\.tech|isVodPlaylist=true|not[_-]?available|unavailable|offline|placeholder|slate|barker)/i.test(streamUrl)) {
      return { url: null, error: `TDMax devolvió placeholder/VOD en lugar de señal live: ${streamUrl.substring(0, 140)}` };
    }

    const isTeleticaCdnStream = (() => {
      try {
        return new URL(streamUrl).hostname.toLowerCase().includes('teletica.com');
      } catch {
        return false;
      }
    })();

    // Validación desde el mismo VPS antes de entregar la URL: si TDMax/Teletica
    // responde URL realmente muerta (404/410) o playlist VOD terminada, no la
    // aceptamos. 403 NO es fatal: los CDNs de TDMax (cdn02/cdn12.teletica.com)
    // suelen devolver 403 a HEAD/GET sin Referer correcto aunque FFmpeg
    // luego sí pueda abrir el stream con los headers spoofed. Verificar con
    // los mismos headers que usará FFmpeg (Referer/Origin app.tdmax.com).
    try {
      const verifyResp = await fetchWithOptionalProxy(streamUrl, {
        headers: {
          'User-Agent': TDMAX_WEB_USER_AGENT,
          'Referer': TDMAX_APP_REFERER,
          'Origin': TDMAX_APP_ORIGIN,
          ...TDMAX_BROWSER_HEADERS,
          ...(!isTeleticaCdnStream && allCookieStr ? { Cookie: allCookieStr } : {}),
        },
        signal: AbortSignal.timeout(10000),
      }, useProxy);
      if (verifyResp.status === 404 || verifyResp.status === 410) {
        return { url: null, error: `TDMax devolvió URL muerta para ${channelName}: HTTP ${verifyResp.status}` };
      }
      if (verifyResp.ok) {
        const verifyText = await verifyResp.text();
        if (!verifyText.trimStart().startsWith('#EXTM3U') || /#EXT-X-ENDLIST/i.test(verifyText)) {
          return { url: null, error: `TDMax devolvió URL no-live (VOD/ended) para ${channelName}` };
        }
      } else if (TDMAX_CDN_BLOCKED_PROCESSES.has(String(processId)) && [401, 403].includes(verifyResp.status)) {
        // FOX/FOX+ en cdn12.teletica.com puede devolver 403 en el GET de
        // verificación aunque el wmsAuthSign sea válido para FFmpeg. No debemos
        // abortar aquí: el edge function ya trata este 403 como no fatal y el
        // VPS debe hacer lo mismo para no caer antes de probar con FFmpeg.
        sendLog('system', 'warn', `⚠️ Verify ${channelName}: HTTP ${verifyResp.status} en pre-check; no fatal, lanzando FFmpeg con URL firmada + headers TDMax.`);
      } else {
        // 403/401/5xx con headers correctos: probablemente el CDN exige cookie
        // de sesión que FFmpeg recibirá en runtime. Confiamos en FFmpeg y
        // dejamos pasar la URL — sólo loggeamos.
        sendLog('system', 'info', `ℹ️ Verify ${channelName}: HTTP ${verifyResp.status} (no fatal, FFmpeg reintentará con headers).`);
      }
    } catch (verr) {
      sendLog('system', 'info', `ℹ️ Verify ${channelName} falló (${verr.message}), entregando URL igual.`);
    }
    
    const cookieCount = allCookieParts.filter(Boolean).length;
    sendLog('system', 'success', `✅ URL LOCAL obtenida para ${channelName}${cookieCount > 0 ? ` (${cookieCount} cookies para CDN)` : ''}`);
    
    // Retornar URL + accessToken + cookies para que FFmpeg los use
    return { url: streamUrl, accessToken, cookies: allCookieStr || null };
  } catch (err) {
    // Exponer la causa real del fetch (DNS/TLS/timeout/conn reset) para que
    // el dashboard muestre algo accionable en vez del genérico "fetch failed".
    const cause = err && err.cause ? err.cause : null;
    const causeBits = cause
      ? [cause.code, cause.errno, cause.syscall, cause.hostname, cause.message]
          .filter(Boolean)
          .join(' ')
      : '';
    const detail = causeBits ? `${err.message} — ${causeBits}` : err.message;
    return { url: null, error: `Error en scraping local: ${detail}` };
  }
};

// Scraping vía Edge Function (fallback si el local no está disponible)
const scrapeStreamUrlRemote = async (channelId, channelName, { account = 'default', processId = null } = {}) => {
  sendLog('system', 'info', `🔄 Scraping REMOTO ${channelName} [cuenta ${account}${processId !== null ? ` pid:${processId}` : ''}]: obteniendo URL via Edge Function...`);
  
  try {
    const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/scrape-channel`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ mode: 'full', channel_id: channelId, account, process_id: processId }),
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
  return await scrapeStreamUrlRemote(channelId, channelName, { account: opts.account || 'default', processId: opts.processId ?? null });
};

const scrapeStreamUrlWithRetries = async (process_id, channelId, channelName) => {
  let lastError = 'No se obtuvo URL';
  const useProxy = PROXY_PROCESSES.has(String(process_id));
  const account = accountForProcess(process_id);

  for (let attempt = 1; attempt <= RECOVERY_SCRAPE_ATTEMPTS; attempt++) {
    try {
      const result = await scrapeStreamUrl(channelId, channelName, { useProxy, account, processId: process_id });

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
  if (isProcessManuallyStopped(process_id)) {
    sendLog(process_id, 'info', `🛑 AUTO-RECOVERY cancelado: parada manual detectada para ${channelName}`);
    return;
  }
  
  if (autoRecoveryInProgress.get(process_id)) {
    sendLog(process_id, 'warn', '⏳ Auto-recovery ya en progreso, ignorando...');
    return;
  }
  
  autoRecoveryInProgress.set(process_id, true);
    const attempts = (recoveryAttempts.get(process_id) || 0) + 1;
    recoveryAttempts.set(process_id, attempts);
    const isAlwaysOnScrapedProcess = async () => {
      if (!supabase) return false;
      try {
        const { data } = await supabase
          .from('emission_processes')
          .select('always_on')
          .eq('id', parseInt(process_id))
          .maybeSingle();
        return Boolean(data?.always_on);
      } catch {
        return false;
      }
    };
  
  let newUrl = null;
  const fallbackUrl = CHANNEL_FALLBACK_URLS[process_id];
  const rememberedState = getRememberedStreamState(process_id);

  // ── Modo Telecable (cualquier pid): relogin y URL fresca, sin scraping TDMax.
  //    Si el login falla, el flujo cae al circuit breaker existente.
  if (isTelecableMode(process_id)) {
    sendLog(process_id, 'info',
      `🔄 AUTO-RECOVERY ${channelName} (intento #${attempts}) — Telecable: refrescando URL firmada...`);
    try {
      const st = await safeTelecableResolve(process_id);
      newUrl = st.url;
    } catch (e) {
      sendLog(process_id, 'error', `❌ AUTO-RECOVERY Telecable falló: ${e.message}`);
      autoRecoveryInProgress.set(process_id, false);
      return;
    }
  }

  // Si es el segundo intento (o más) y hay fallback, usar directamente la URL oficial
  if (!newUrl && attempts >= 2 && fallbackUrl) {
    sendLog(process_id, 'warn', `🔄 AUTO-RECOVERY ${channelName} (intento #${attempts}): Usando URL oficial de respaldo...`);
    newUrl = fallbackUrl;
  } else if (!newUrl) {
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

    const recoveryOutputProfile = rememberedState?.output_profile || getStoredOutputProfile(process_id);
    rememberStreamState(process_id, { source_m3u8: newUrl, target_rtmp: targetRtmp, output_profile: recoveryOutputProfile });
    
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
        output_profile: recoveryOutputProfile,
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
      output.includes('HTTP error 404') ||
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
      output.includes('HTTP error 404') ||
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

// Probe de codecs (video + audio) para decidir copy-vs-transcode en modo 'smart'.
// Devuelve { videoCodec, audioCodec } en lowercase, o strings vacíos si falla.
// Acepta opcionalmente headers HTTP (referer/user-agent/extra) para que el probe
// pueda llegar a CDNs con autenticación por header (ej. M3U con #EXTVLCOPT).
const detectSourceCodecs = async (source, httpHeaders = '', userAgent = '', referer = '') => {
  return new Promise((resolve) => {
    const args = ['-v', 'error'];
    if (userAgent) args.push('-user_agent', userAgent);
    if (referer) args.push('-referer', referer);
    if (httpHeaders) args.push('-headers', httpHeaders);
    args.push(
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      '-analyzeduration', '3000000',
      '-probesize', '2000000',
      source
    );
    const probe = spawn('ffprobe', args);
    let output = '';
    let errOut = '';
    let done = false;
    const finish = (result) => { if (done) return; done = true; resolve(result); };
    probe.stdout.on('data', d => { output += d.toString(); });
    probe.stderr.on('data', d => { errOut += d.toString(); });
    probe.on('close', () => {
      try {
        const data = JSON.parse(output);
        let videoCodec = '';
        let audioCodec = '';
        for (const s of (data.streams || [])) {
          if (s.codec_type === 'video' && !videoCodec) videoCodec = String(s.codec_name || '').toLowerCase();
          else if (s.codec_type === 'audio' && !audioCodec) audioCodec = String(s.codec_name || '').toLowerCase();
        }
        finish({ videoCodec, audioCodec, error: errOut.slice(0, 300) });
      } catch (e) {
        finish({ videoCodec: '', audioCodec: '', error: errOut.slice(0, 300) || e.message });
      }
    });
    probe.on('error', (e) => finish({ videoCodec: '', audioCodec: '', error: e.message }));
    // Timeout de seguridad: si ffprobe se cuelga, abortar a los 12s
    setTimeout(() => { try { probe.kill('SIGKILL'); } catch {} finish({ videoCodec: '', audioCodec: '', error: 'probe-timeout' }); }, 12000);
  });
};

// Detecta el framerate REAL de la fuente vía ffprobe y lo mapea al estándar
// más cercano para evitar drift / frames duplicados. Devuelve null si falla
// (el caller debe usar su fallback). Acepta headers HTTP igual que detectSourceCodecs.
//
// Mapeo a fps "limpios":
//   23.5–24.5  → si decimal ~0.976 → 23.976, si entero → 24
//   24.5–25.5  → 25
//   29–30.5    → si ~0.97 → 29.97, si entero → 30
//   49–50.5    → 50
//   58–60.5    → si ~0.94 → 59.94, si entero → 60
const detectSourceFps = async (source, httpHeaders = '', userAgent = '', referer = '') => {
  return new Promise((resolve) => {
    const args = ['-v', 'error'];
    if (userAgent) args.push('-user_agent', userAgent);
    if (referer) args.push('-referer', referer);
    if (httpHeaders) args.push('-headers', httpHeaders);
    args.push(
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate,avg_frame_rate',
      '-of', 'json',
      '-analyzeduration', '3000000',
      '-probesize', '2000000',
      source
    );
    const probe = spawn('ffprobe', args);
    let output = '';
    let done = false;
    const finish = (result) => { if (done) return; done = true; resolve(result); };
    probe.stdout.on('data', d => { output += d.toString(); });
    probe.on('close', () => {
      try {
        const data = JSON.parse(output);
        const s = (data.streams || [])[0] || {};
        const parseFrac = (str) => {
          if (!str || typeof str !== 'string' || str === '0/0') return 0;
          const [n, d] = str.split('/').map(Number);
          if (!n || !d) return 0;
          return n / d;
        };
        const r = parseFrac(s.r_frame_rate);
        const avg = parseFrac(s.avg_frame_rate);
        // Preferimos avg_frame_rate (real), pero si es 0 o muy raro caemos a r_frame_rate.
        let raw = avg > 0 ? avg : r;
        if (!raw || !isFinite(raw) || raw <= 0 || raw > 120) {
          return finish({ rawFps: 0, fps: null, gop: null });
        }
        // Mapear a estándar más cercano.
        let fps = null;
        if (raw >= 23 && raw <= 24.4) {
          fps = raw < 23.95 ? 23.976 : 24;
        } else if (raw > 24.4 && raw <= 25.5) {
          fps = 25;
        } else if (raw > 25.5 && raw <= 28.9) {
          // valores raros (ej. 27fps) — redondeo simple
          fps = Math.round(raw);
        } else if (raw > 28.9 && raw <= 30.5) {
          fps = raw < 29.99 ? 29.97 : 30;
        } else if (raw > 30.5 && raw <= 49.5) {
          fps = Math.round(raw);
        } else if (raw > 49.5 && raw <= 50.5) {
          fps = 50;
        } else if (raw > 50.5 && raw <= 60.5) {
          fps = raw < 59.99 ? 59.94 : 60;
        } else {
          fps = Math.round(raw);
        }
        // GOP = 2 segundos al fps elegido.
        const gop = +(fps * 2).toFixed(3);
        finish({ rawFps: +raw.toFixed(3), fps, gop });
      } catch (_) {
        finish({ rawFps: 0, fps: null, gop: null });
      }
    });
    probe.on('error', () => finish({ rawFps: 0, fps: null, gop: null }));
    // Timeout duro: 7s. Fuentes HTTP normales responden en <2s; si cuelga, seguimos con fallback.
    setTimeout(() => { try { probe.kill('SIGKILL'); } catch {} finish({ rawFps: 0, fps: null, gop: null }); }, 7000);
  });
};

// Endpoint para scraping LOCAL desde el VPS (para que el token se genere con la IP del VPS)
// Esto es CRÍTICO para canales como Tigo cuyo CDN valida IP del token vs IP del consumidor
// Rate-limit cap: máx 10 scrapes por canal en ventana de 5 min (evita "loco" como pasó hoy)
const LOCAL_SCRAPE_RATE_LIMIT = { maxCalls: 10, windowMs: 5 * 60 * 1000 };
const localScrapeCallLog = new Map(); // channel_id -> [timestamps]
app.post('/api/local-scrape', async (req, res) => {
  try {
    const { channel_id, process_id, player_url } = req.body;
    
    if (!channel_id) {
      return res.status(400).json({ success: false, error: 'Falta channel_id' });
    }

    // Rate-limit por channel_id
    const now = Date.now();
    const key = String(channel_id);
    const recent = (localScrapeCallLog.get(key) || []).filter(t => now - t < LOCAL_SCRAPE_RATE_LIMIT.windowMs);
    if (recent.length >= LOCAL_SCRAPE_RATE_LIMIT.maxCalls) {
      const oldestAge = Math.round((now - recent[0]) / 1000);
      const waitSec = Math.round((LOCAL_SCRAPE_RATE_LIMIT.windowMs - (now - recent[0])) / 1000);
      sendLog(String(process_id ?? 'system'), 'warn', `🛑 Rate-limit scraping: ${recent.length} intentos en últimos ${oldestAge}s para ${key.substring(0,8)} — espera ${waitSec}s`);
      return res.status(429).json({ success: false, error: `Demasiados intentos de scraping (máx ${LOCAL_SCRAPE_RATE_LIMIT.maxCalls}/5min). Espera ${waitSec}s.` });
    }
    recent.push(now);
    localScrapeCallLog.set(key, recent);

    const channelName = CHANNEL_MAP[process_id]?.channelName || `Canal ${channel_id.substring(0, 8)}`;
    const useProxy = PROXY_PROCESSES.has(String(process_id));
    const account = accountForProcess(process_id);
    const result = await scrapeStreamUrlLocal(channel_id, channelName, { useProxy, account, processId: process_id });
    
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

    // FOX+ ALTERNO (26): persistir player_url igual que FUTV ALTERNO
    if (String(process_id) === '26' && player_url && supabase) {
      try {
        await supabase
          .from('emission_processes')
          .update({ player_url: String(player_url) })
          .eq('id', 26);
        sendLog('26', 'info', `💾 player_url guardado para auto-recovery tras reinicio`);
      } catch (e) {
        sendLog('26', 'warn', `⚠️ No se pudo guardar player_url: ${e.message}`);
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
    const {
      source_m3u8,
      target_rtmp,
      process_id: rawProcessId = '0',
      is_recovery = false,
      passthrough = false,
      passthrough_mode = null, // 'copy' | 'smart' | 'transcode' | null
      extra_headers = null,
      referer: customReferer = null,
      user_agent: customUserAgent = null,
      output_profile = null,
      source_mode = null, // Teletica URL (13): 'official' | 'scraping'
      telecable_content_id = null, // Disney 7 pid 0: contentId elegido en dropdown
    } = req.body;
    // Anti-doble-emit: si llega un segundo POST /api/emit para el mismo pid
    // mientras el primero todavía está arrancando, devolvemos 409 y NO
    // spawneamos otro FFmpeg en paralelo (causaba dos procesos con perfiles
    // distintos compitiendo por la misma salida HLS).
    const _dedupePid = String(rawProcessId);
    if (emitInFlight.has(_dedupePid)) {
      sendLog(_dedupePid, 'warn', `⏸️ /api/emit ignorado: ya hay una solicitud en curso para este pid`);
      return res.status(409).json({ error: 'Emit en curso, ignorando duplicado' });
    }
    emitInFlight.add(_dedupePid);
    res.on('finish', () => emitInFlight.delete(_dedupePid));
    res.on('close', () => emitInFlight.delete(_dedupePid));
    // Normalizar el modo. Compat: si llega `passthrough: true` sin `passthrough_mode`,
    // asumimos 'copy' (comportamiento histórico). Si llega 'transcode', desactivamos
    // el flag para que NO se ejecute el bloque de strip de transcoding.
    const normalizedMode = (() => {
      const m = (passthrough_mode || '').toString().toLowerCase();
      if (['copy', 'smart', 'transcode', 'rawvideo'].includes(m)) return m;
      // Compat histórica: passthrough:true sin mode → para ID 19 ahora default 'rawvideo'
      // (video crudo + audio AAC re-encode), para otros 'copy' como antes.
      if (passthrough === true) {
        return String(rawProcessId) === '19' ? 'rawvideo' : 'copy';
      }
      return null;
    })();
    const isPassthroughBlock = normalizedMode === 'copy' || normalizedMode === 'smart' || normalizedMode === 'rawvideo';
    const process_id = String(rawProcessId);
    const numericId = parseInt(process_id, 10);
    const outputProfileKey = saveOutputProfileForProcess(process_id, output_profile || getStoredOutputProfile(process_id));
    const outputProfile = getOutputProfileConfig(outputProfileKey);
    let effectiveSourceM3u8 = source_m3u8;
    const isHlsOutput = HLS_OUTPUT_PROCESSES.has(process_id);
    const isTigoHdmiProcess = process_id === '12' && TIGO_USE_HDMI;

    // ── TELETICA URL (13): persistir modo enviado por el frontend y, si es
    //    'official', sobrescribir el source con la URL fija de Bradmax CDN.
    //    En 'official' NO se hace scraping previo; el FFmpeg lee directo de la
    //    CDN con Referer https://bradmax.com/.
    if (process_id === '13' && !is_recovery && (source_mode === 'official' || source_mode === 'scraping')) {
      setTeleticaSourceMode('13', source_mode);
      sendLog('13', 'info', `🎛️ Modo Teletica seleccionado: ${source_mode.toUpperCase()}`);
      // Inicio manual del usuario → resetear contador de reintentos oficiales.
      teleticaOfficialFailures.set('13', 0);
    }
    if (process_id === '13' && getTeleticaSourceMode('13') === 'official') {
      effectiveSourceM3u8 = TELETICA_OFFICIAL_URL;
    }

    // ── CANAL 6 URL (15): persistir modo enviado por el frontend.
    //    En 'official' usamos la URL pegada por el usuario tal cual (no hay
    //    CDN fija). En 'scraping' seguimos el flujo TDMax actual. El FFmpeg
    //    sale igualmente por el túnel CR (pid ∈ CHANNELS_VIA_PI_WG).
    if (process_id === '15' && !is_recovery && (source_mode === 'official' || source_mode === 'scraping')) {
      setCanal6SourceMode('15', source_mode);
      sendLog('15', 'info', `🎛️ Modo Canal 6 seleccionado: ${source_mode.toUpperCase()}`);
    }
    if (process_id === '15' && getCanal6SourceMode('15') === 'official' && source_m3u8) {
      sendLog('15', 'info', `🎯 Canal 6 OFICIAL: usando URL pegada por usuario`);
      // effectiveSourceM3u8 ya viene del request — no sobrescribir.
    }

    // ── TELECABLE (pids en TELECABLE_PROCESSES) ────────────────────────
    //    'telecable' = login directo desde el VPS a la API de Telecable;
    //    se resuelve URL HLS firmada y se reemplaza effectiveSourceM3u8.
    //    El FFmpeg sale por la IP del VPS (NO por túnel CR), porque la
    //    firma del CDN está atada a esa IP.
    if (TELECABLE_PROCESSES.has(String(process_id)) && !is_recovery && (source_mode === 'telecable' || source_mode === 'telecable_vlc')) {
      setTelecableSourceMode(process_id, source_mode);
      const isVlc = source_mode === 'telecable_vlc';
      sendLog(process_id, 'info', `🎛️ Modo TELECABLE${isVlc ? ' + perfil Disney7 (VLC LIKE)' : ''} activado (pid ${process_id})`);
      telecableFailureCount.set(String(process_id), 0);
    } else if (TELECABLE_PROCESSES.has(String(process_id)) && !is_recovery && source_mode && source_mode !== 'telecable' && source_mode !== 'telecable_vlc') {
      // Cualquier otro source_mode (scraping/official) desactiva Telecable.
      setTelecableSourceMode(process_id, 'scraping');
    }
    if (isTelecableMode(process_id)) {
      try {
        const cached = telecableState.get(String(process_id));
        // Disney 7 (pid 0): el contentId puede cambiar entre arranques (dropdown).
        // Si llegó override y difiere del cacheado, forzamos re-resolve.
        const overrideCid = process_id === '0' && telecable_content_id ? String(telecable_content_id) : null;
        if (overrideCid && cached && cached.contentId !== overrideCid) {
          telecableState.delete(String(process_id));
        }
        // Si el frontend trajo override, lo persistimos en la caché para que
        // los auto-recoveries futuros reusen el mismo canal.
        if (overrideCid && (!cached || cached.contentId !== overrideCid)) {
          telecableState.set(String(process_id), { contentId: overrideCid });
        }
        const stillFresh = cached?.expiresAt &&
          (!overrideCid || cached.contentId === overrideCid) &&
          (cached.expiresAt - Math.floor(Date.now() / 1000) > TELECABLE_REFRESH_MARGIN_S) &&
          is_recovery;
        const st = stillFresh ? cached : await safeTelecableResolve(process_id, overrideCid);
        effectiveSourceM3u8 = st.url;
        sendLog(process_id, 'info', `📡 Telecable → consumiendo HLS firmado (IP VPS)`);
      } catch (e) {
        sendLog(process_id, 'error', `❌ No se pudo obtener URL Telecable: ${e.message}`);
        return res.status(502).json({ error: `Telecable: ${e.message}` });
      }
    }

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

    // Validación de ID: debe ser un número entre 0 y 30 (21 = Teletica SRT)
    if (isNaN(numericId) || numericId < 0 || numericId > 30) {
      sendLog(process_id, 'error', `❌ ID de proceso inválido: "${rawProcessId}" (debe ser 0-30)`);
      return res.status(400).json({ error: `ID de proceso inválido: debe ser un número entre 0 y 30` });
    }

    // Resetear contador y limpiar flags de parada manual SOLO cuando es inicio manual
    if (!is_recovery) {
      recoveryAttempts.set(process_id, 0);
      manualStopProcesses.delete(process_id);
      manualStopProcesses.delete(numericId);
      nightRestStoppedProcesses.delete(process_id);
      resetCircuitBreaker(process_id);
    }
    
    sendLog(process_id, 'info', `Nueva solicitud de emisión recibida`, { source_m3u8, target_rtmp, output_profile: outputProfileKey });

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
    // En modo Telecable (cualquier pid), la URL firmada ya viene resuelta por login
    // directo desde el VPS — NO se debe scrapear vía Pi5/TDMax. Saltar el refresh JIT.
    const isAnyTelecable = isTelecableMode(process_id);
    if (!isTigoHdmiProcess && !isAnyTelecable && PROXY_PROCESSES.has(process_id) && CHANNEL_MAP[process_id]) {
      const cached = scrapeSessionCache.get(process_id);
      const cacheAgeMs = cached?.timestamp ? Date.now() - cached.timestamp : Infinity;
      const skipRefresh = is_recovery && cacheAgeMs < 10000;

      if (skipRefresh) {
        sendLog(process_id, 'info', `♻️ Reusando URL fresca del Quick Retry (scrapeada hace ${Math.round(cacheAgeMs / 1000)}s) — sin doble scrape`);
      } else {
        const { channelId, channelName } = CHANNEL_MAP[process_id];
        sendLog(process_id, 'info', `🔄 Refrescando URL via Pi5 (token de 60s)...`);
        const fresh = await scrapeStreamUrlLocal(channelId, channelName, { useProxy: true, account: accountForProcess(process_id), processId: process_id });
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

    rememberStreamState(process_id, { source_m3u8: effectiveSourceM3u8, target_rtmp, output_profile: outputProfileKey });

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

    // GUARD de exclusividad por slug HLS:
    // IDs que comparten slug (0/16/19 → Disney7, 11/17/18 → futv, 22/24/26 → foxmas,
    // 23/25 → fox, 14 tdmas, 15/20 canal6, 13/21 teletica) NO pueden emitir a la vez
    // al mismo destino. Antes rechazábamos con 409; ahora hacemos TAKEOVER:
    // matamos cualquier otro pid con el mismo slug (ffmpeg + SRT listener si lo tiene)
    // y limpiamos /live/<slug>/ para evitar emisiones "fantasma" con segmentos viejos.
    if (isHlsOutput) {
      const mySlug = HLS_SLUG_MAP[process_id];
      if (mySlug) {
        const myLabel = CHANNEL_CONFIGS_SERVER[process_id] || `Proceso ${process_id}`;
        for (const [otherPid, otherSlug] of Object.entries(HLS_SLUG_MAP)) {
          if (otherPid === process_id) continue;
          if (otherSlug !== mySlug) continue;
          const otherProc = ffmpegProcesses.get(otherPid);
          const otherSrt = srtListenerProcesses.get(String(otherPid));
          const otherAlive = (otherProc && otherProc.process && !otherProc.process.killed) ||
                             (otherSrt && !otherSrt.killed && otherSrt.exitCode === null);
          if (!otherAlive) continue;
          const otherLabel = CHANNEL_CONFIGS_SERVER[otherPid] || `Proceso ${otherPid}`;
          sendLog(process_id, 'warn', `🔄 TAKEOVER slug "${mySlug}": deteniendo ${otherLabel} (ID ${otherPid}) para que ${myLabel} tome la salida.`);
          // Marcar como parada manual para que su close-handler NO dispare recovery.
          manualStopProcesses.add(String(otherPid));
          manualStopProcesses.add(Number(otherPid));
          if (otherProc && otherProc.process && !otherProc.process.killed) {
            try { otherProc.process.kill('SIGTERM'); } catch (_) {}
            try { await waitForProcessDeath(otherProc.process, 2000); } catch (_) {}
            ffmpegProcesses.delete(otherPid);
          }
          // Si el pid víctima tiene listener SRT persistente (16/18/20/21/22/23), también lo bajamos.
          try { stopSrtListener(otherPid); } catch (_) {}
          emissionStatuses.set(otherPid, 'idle');
          // Persistir estado detenido en DB.
          if (supabase) {
            try {
              await supabase.from('emission_processes').update({
                is_active: false,
                is_emitting: false,
                ended_at: new Date().toISOString(),
                emit_status: 'stopped',
                emit_msg: `Detenido por takeover: ${myLabel} tomó el slug ${mySlug}`,
                start_time: 0,
                elapsed: 0,
                ffmpeg_pid: null,
              }).eq('id', parseInt(otherPid));
            } catch (_) {}
          }
          // Limpiar flag manual tras un pequeño delay para evitar carreras con recovery inmediato.
          setTimeout(() => {
            manualStopProcesses.delete(String(otherPid));
            manualStopProcesses.delete(Number(otherPid));
          }, 3000);
        }
        // Limpiar /live/<slug>/ (segmentos viejos + playlist) para que ningún cliente
        // reciba fragmentos del proceso anterior mientras arranca el nuevo.
        try {
          const dir = path.join(HLS_OUTPUT_DIR, mySlug);
          if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              if (f.endsWith('.m3u8') || f.endsWith('.ts')) {
                try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
              }
            }
            sendLog(process_id, 'info', `🧹 /live/${mySlug}/ limpiado antes de arrancar (takeover)`);
          }
        } catch (e) {
          sendLog(process_id, 'warn', `⚠️ No se pudo limpiar /live/${mySlug}/: ${e.message}`);
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
        output_profile: outputProfileKey,
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
    const isCanal6UrlProcess = String(process_id) === '15';
    let refererDomain = 'https://www.tdmax.com/';
    let originDomain = 'https://www.tdmax.com';
    let isUnivisionLikeSource = false;
    let isMediatiqueSource = false;
    let isAkamaiSource = false;
    let isTelecableSource = false;
    try {
      const sourceUrl = new URL(effectiveSourceM3u8);
      const hostname = sourceUrl.hostname.toLowerCase();

      if (hostname.includes('teletica.com')) {
        // Teletica CDN tiene DOS rutas con políticas de Referer distintas:
        //   • /TeleticaLiveStream/...  → fuente "oficial" pública vía Bradmax player.
        //     Solo valida Referer https://bradmax.com/  (sin token, sin wmsAuthSign).
        //   • /StreamTeletica/... (cdn02/cdn12) → ruta TDMax con wmsAuthSign de 60s.
        //     Valida Referer/Origin contra https://app.tdmax.com/. Si se manda
        //     teletica.com como Origin, CDN responde 200 OK pero con chunks vacíos.
        if (sourceUrl.pathname.toLowerCase().includes('/teleticalivestream/')) {
          refererDomain = 'https://bradmax.com/';
          originDomain = 'https://bradmax.com';
        } else {
          refererDomain = TDMAX_APP_REFERER;
          originDomain = TDMAX_APP_ORIGIN;
        }
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
      } else if (hostname.includes('telecable') || hostname.includes('mtvreg.com')) {
        // Telecable HLS firmado (stream.srv.telecable.i.mtvreg.com).
        // El CDN devuelve EOF de forma "normal" entre segmentos y rechaza
        // reconexiones a byte-offset → con -re + +genpts + -reconnect_at_eof
        // FFmpeg queda en loop sin primer frame (Disney 7 colgaba a 47s).
        // Tratamos esta fuente exactamente como Canal 8/Canal 2: perfil
        // minimal VLC-like, dejar que el demuxer HLS interno haga su trabajo.
        isTelecableSource = true;
      }
    } catch (_) {
      // Mantener fallback TDMax si la URL llega incompleta o malformada
    }

    // ── VLC LIKE override ────────────────────────────────────────────────
    // El perfil agresivo Disney 7 (-re + +genpts + reconnect_at_eof + max_reload=1000)
    // es INCOMPATIBLE con URLs Telecable: el CDN devuelve EOF "normal" entre segmentos
    // y FFmpeg queda en loop de reconexión sin primer frame → watchdog kill a ~50s.
    // Si el usuario activó VLC LIKE sobre una URL Telecable, ignoramos el override
    // y mantenemos el perfil minimal Telecable (que ya funciona estable).
    const forceDisney7Profile = isTelecableVlcMode(process_id);
    if (forceDisney7Profile) {
      if (isTelecableSource) {
        sendLog(process_id, 'warn', `⚠️ VLC LIKE ignorado: URL Telecable es incompatible con el perfil Disney 7 (EOF loop). Usando perfil minimal Telecable, que ya es estable.`);
      } else {
        isTelecableSource = false;
        sendLog(process_id, 'info', `🎬 VLC LIKE: forzando perfil Disney 7 agresivo sobre URL Telecable`);
      }
    }

    // RANDOM Disney 7 (ID 19) o cualquier proceso que envíe referer custom desde el M3U:
    // sobreescribir refererDomain/originDomain con los valores que vienen del archivo M3U.
    if (customReferer && typeof customReferer === 'string') {
      refererDomain = customReferer;
      try {
        const refUrl = new URL(customReferer);
        originDomain = `${refUrl.protocol}//${refUrl.host}`;
      } catch (_) {
        // Si el referer no es URL válida, dejar originDomain por defecto
      }
      sendLog(process_id, 'info', `🧾 Referer/Origin custom (M3U): ${refererDomain}`);
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
    // FOX+ ALTERNO (26) idem (URL TDMax eventual pegada por el usuario).
    const needsTdmaxLikePinning = isScrapedChannel || process_id === '17' || process_id === '26';

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
    } else if (process_id === '19') {
      // RANDOM Disney 7 (M3U file passthrough): perfil VLC-like idéntico a
      // Disney 7 (ID 0) — max_reload/hold altos + genpts. NO usamos variant
      // pinning ni pre-check (la URL del M3U puede ser playlist directa).
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-max_reload', '1000',
        '-m3u8_hold_counters', '1000',
        '-fflags', '+genpts'
      );
      sendLog(process_id, 'info', `🛡️ RANDOM Disney 7 HLS resiliente: max_reload=1000, hold=1000`);
    } else if (isTelecableSource) {
      // Telecable: NO agregamos -http_seekable, -max_reload ni +genpts.
      // Exactamente el mismo perfil minimal con el que Canal 8/2 funcionan
      // sin colgarse. El demuxer HLS interno maneja todo.
      sendLog(process_id, 'info', `🛡️ Telecable HLS: perfil minimal (igual que Canal 8/2)`);
    } else if (isManualProcess || needsTdmaxLikePinning) {
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-max_reload', '1000',
        '-m3u8_hold_counters', '1000'
      );
      // Canal 6 URL: el PTS original se rompe después del primer reload en FFmpeg.
      // Volvemos a reloj generado lineal y sólo dejamos el master vivo + programa fijo.
      hardenedLiveInputArgs.push('-fflags', '+genpts');
      if (isCanal6UrlProcess) {
        hardenedLiveInputArgs.push('-live_start_index', '-2');
        sendLog(process_id, 'info', `🎯 Canal 6 URL: reloj lineal + master vivo + inicio live -2`);
      }
      sendLog(process_id, 'info', `🛡️ HLS resiliente: max_reload=1000, hold=1000`);
    }
    // Mantener -re como pacing de entrada para HLS live.
    // Quitar -re hace que FFmpeg lea a velocidad CPU, agote segmentos y termine en EOF.
    // Los reloads deben mitigarse fijando la variante HLS final antes de FFmpeg,
    // no dejando el master playlist completo al analizador interno.
    // ID 19 (RANDOM Disney 7) hereda -re de Disney 7 para pacing HLS correcto.
    // Telecable NUNCA usa -re: el CDN ya pacing por segmentos y -re causa
    // que FFmpeg se quede esperando datos que el CDN no envía hasta EOF.
    const usesReFlag = !isTelecableSource && (
      RE_FLAG_PROCESSES.has(String(process_id)) ||
      String(process_id) === '19' ||
      forceDisney7Profile
    );
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
        // Igual que Authorization: las cookies pertenecen a TDMax/API, no al CDN
        // cdn12/cdn02.teletica.com. Para FOX/FOX+/Teletica URL, el acceso válido
        // es la firma wmsAuthSign + Referer/Origin; cookies extra pueden disparar 403.
        if (cachedSession.cookies && !isTeleticaSource) {
          sessionCookies = cachedSession.cookies;
          extraFfmpegInputArgs.push('-cookies', cachedSession.cookies + '\n');
          sendLog(process_id, 'info', `🍪 Inyectando cookies de sesión a FFmpeg`);
        } else if (cachedSession.cookies && isTeleticaSource) {
          sendLog(process_id, 'info', `🍪 Teletica CDN: cookies TDMax NO se envían a FFmpeg; se usa URL firmada limpia`);
        }
        // El accessToken de TDMax solo sirve contra el API/loadbalancer. En el CDN
        // Teletica (cdn12/cdn02 con wmsAuthSign) FFmpeg debe comportarse como VLC:
        // URL firmada + Referer/Origin, SIN Authorization. Enviar Bearer al CDN puede
        // provocar 403 inmediato aunque el wmsAuthSign sea fresco.
        if (cachedSession.accessToken && !isTeleticaSource) {
          authorizationValue = `Bearer ${cachedSession.accessToken}`;
          authorizationHeader = `Authorization: ${authorizationValue}`;
          sendLog(process_id, 'info', `🔑 Inyectando accessToken a FFmpeg`);
        } else if (cachedSession.accessToken && isTeleticaSource) {
          sendLog(process_id, 'info', `🔑 Teletica CDN: accessToken NO se envía a FFmpeg; se usa wmsAuthSign + Referer/Origin`);
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
      // Mediatiquestream (Canal 6): perfil simple tipo VLC.
      // Sin reconnect HTTP: el demuxer HLS maneja playlist/segmentos y evitamos esperas
      // largas que terminan en audio adelantado mientras el video intenta ponerse al día.
      effectiveResilienceArgs = [
        '-rw_timeout', '30000000',
      ];
      sendLog(process_id, 'info', `🔧 Mediatiquestream: modo VLC-like simple (sin reconnect HTTP)`);
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
    } else if (isProxyScrapedSource || isTeleticaSource) {
      // Tigo via Pi5 y Teletica CDN: el token ya viene fresco del scraper, pero
      // reconnect_streamed/reconnect_at_eof rompen el demuxer HLS y provocan
      // loops de EOF/byte-offset (similar a VLC vs FFmpeg en otros CDNs).
      // Estrategia: dejar SOLO al demuxer HLS recargar playlists/segmentos.
      effectiveResilienceArgs = [
        '-rw_timeout', '30000000',
      ];
      sendLog(process_id, 'info', `🔧 ${isTeleticaSource ? 'Teletica CDN' : 'Tigo via Pi5'}: modo VLC-like (sin reconnect HTTP, solo demuxer HLS)`);
    } else if (process_id === '19') {
      // RANDOM Disney 7: misma resiliencia que Disney 7 (ID 0) manual.
      // reconnect_at_eof + reconnect_streamed + delay_max=15s cubren caídas
      // transitorias del CDN sin matar el demuxer.
      effectiveResilienceArgs = [
        '-rw_timeout', '15000000',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_on_http_error', '4xx,5xx',
        '-reconnect_delay_max', '15',
      ];
      sendLog(process_id, 'info', `🔧 RANDOM Disney 7: resiliencia tipo Disney 7 (reconnect 4xx/5xx, eof, 15s)`);
    } else if (isTelecableSource) {
      // Telecable: mismo perfil que Canal 8/2 — HLS_INPUT_RESILIENCE_ARGS estándar.
      // -reconnect_at_eof / byte-offset reconnect rompen el demuxer HLS de Telecable
      // (loop infinito de "Will reconnect at <offset>"), por eso usamos solo 5xx.
      effectiveResilienceArgs = HLS_INPUT_RESILIENCE_ARGS;
      sendLog(process_id, 'info', `🔧 Telecable: resiliencia HLS estándar (sin reconnect at byte-offset)`);
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

    // Headers extra del M3U (RANDOM Disney 7 ID 19): cualquier header arbitrario
    // (sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, etc.) que el archivo M3U
    // declare con `#EXTVLCOPT:http-header=Key:Value`.
    const customHeaderLines = [];
    if (extra_headers && typeof extra_headers === 'object') {
      for (const [k, v] of Object.entries(extra_headers)) {
        if (!k || v === undefined || v === null) continue;
        // Saltar headers que ya gestionamos por separado
        const lk = String(k).toLowerCase();
        if (lk === 'referer' || lk === 'origin' || lk === 'user-agent' || lk === 'authorization') continue;
        customHeaderLines.push(`${k}: ${v}`);
      }
      if (customHeaderLines.length > 0) {
        sendLog(process_id, 'info', `🧾 ${customHeaderLines.length} header(s) custom del M3U inyectados`);
      }
    }

    const teleticaBrowserHeaderLines = isTeleticaSource
      ? Object.entries(TDMAX_BROWSER_HEADERS).map(([key, value]) => `${key}: ${value}`)
      : [];

    const combinedHeaders = [
      authorizationHeader,
      `Referer: ${refererDomain}`,
      `Origin: ${originDomain}`,
      ...teleticaBrowserHeaderLines,
      ...customHeaderLines,
    ].filter(Boolean).join('\r\n') + '\r\n' + univisionExtraHeaders;

    // FASE 1: User-Agent rotativo para Tigo (proxy). Cada arranque/recovery
    // elige un UA distinto del pool → cada reconexión = "cliente nuevo" para Wowza.
    // Si viene un User-Agent custom desde el M3U, tiene prioridad absoluta.
    const sessionUserAgent = customUserAgent
      ? customUserAgent
          : (isCanal6UrlProcess
          ? 'VLC/3.0.20 LibVLC/3.0.20'
          : isProxyScrapedSource
          ? pickRandomUserAgent()
          : isTeleticaSource
          ? TDMAX_WEB_USER_AGENT
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    if (customUserAgent) {
      sendLog(process_id, 'info', `🧾 User-Agent custom (M3U): ${customUserAgent.substring(0, 60)}...`);
    }
    if (isProxyScrapedSource) {
      sendLog(process_id, 'info', `🎭 UA rotativo: ${sessionUserAgent.substring(0, 60)}...`);
    }
      if (isTeleticaSource && !isProxyScrapedSource) {
        sendLog(process_id, 'info', `🧭 Teletica CDN: identidad web TDMax unificada (UA + headers navegador)`);
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
    // Canal 6 URL (15): mantener el master vivo y fijar el programa 720p con -map,
    // igual al método de los scrapeados. Así FFmpeg lee el archivo oficial, conserva
    // los identificadores/programas del HLS y no queda amarrado a una sub-playlist vieja.
    // Otros manuales: pinnear URL hija directa y simplificar FFmpeg.
    // SCRAPEADOS (TDMax): mantener master playlist vivo (token de 1min necesita renovación del CDN)
    //   pero forzar el programa 720p con -map 0:p:N para evitar cambios de calidad.
    const isManualUrlProcess = isManualProcess;
    let hlsProgramIndex = -1; // -1 = sin forzar programa específico

    if (isCanal6UrlProcess) {
      try {
        const { allVariants } = await resolveBestHLSVariant(inputSourceUrl, {
          targetBandwidth: 0,
          headers: {
            Referer: refererDomain,
            Origin: originDomain,
            'User-Agent': sessionUserAgent,
          },
        });

        const validVariants = (allVariants || []).filter(v => v.bandwidth > 0 && v.resolution);
        if (validVariants.length > 0) {
          const target720 = validVariants.find(v => v.resolution && v.resolution.includes('720'));
          const best = target720 || validVariants[validVariants.length - 1];
          hlsProgramIndex = best.programIndex;
          sendLog(process_id, 'success', `📌 Canal 6 URL: master vivo + programa fijo p:${hlsProgramIndex} (${best.resolution} @ ${Math.round(best.bandwidth / 1000)}kbps) [SIN ABR]`);
        } else {
          sendLog(process_id, 'warn', `⚠️ Canal 6 URL: master sin variantes detectables — FFmpeg elegirá automáticamente`);
        }
      } catch (err) {
        sendLog(process_id, 'warn', `⚠️ Canal 6 URL: no se pudo analizar master HLS (${err.message}) — FFmpeg elegirá automáticamente`);
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
    } else if ((isScrapedChannel && isProxyScrapedSource) || isTeleticaSource) {
      // Tigo via Pi5 (Fase 1 endurecida) — Variant Pinning manual.
      // Teletica (ID 13 + ID 4): el master playlist trae wmsAuthSign con
      // validminutes=1. FFmpeg recarga el master cada pocos segundos y al
      // re-firmar pierde la sesión → "End of file" en loop. Resolviendo el
      // master UNA vez aquí, la CDN nos asigna nimblesessionid en la
      // sub-playlist y FFmpeg solo recarga chunks.m3u8 con sesión sticky.
      // Resolvemos el master playlist UNA vez aquí (no FFmpeg) y pasamos
      // directamente la sub-playlist 720p.
      try {
        const masterResp = await fetchWithOptionalProxy(inputSourceUrl, {
          headers: {
            'User-Agent': sessionUserAgent,
            Referer: refererDomain,
            Origin: originDomain,
            ...(isTeleticaSource ? TDMAX_BROWSER_HEADERS : {}),
            ...(authorizationValue ? { Authorization: authorizationValue } : {}),
            ...(sessionCookies ? { Cookie: sessionCookies } : {}),
          },
        }, isProxyScrapedSource);
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
              const pinLabel = isTeleticaSource && !isProxyScrapedSource ? 'Teletica' : 'Tigo';
              sendLog(process_id, 'success', `📌 ${pinLabel} Variant Pinning → ${best.resolution || '?'} @ ${Math.round((best.bandwidth || 0) / 1000)}kbps (sub-playlist directa)`);
            }
          } else {
            sendLog(process_id, 'info', `📺 URL ya es sub-playlist directa (sin master)`);
          }
        } else {
          const pinLabel = isTeleticaSource && !isProxyScrapedSource ? 'Teletica' : 'Tigo';
          sendLog(process_id, 'warn', `⚠️ ${pinLabel} Variant Pinning: master respondió HTTP ${masterResp.status}; FFmpeg probará URL original con headers TDMax.`);
        }
      } catch (err) {
        sendLog(process_id, 'warn', `⚠️ Variant Pinning falló (${err.message}) — usando URL master original`);
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
    const channelLabels = { '0': 'Disney 7', '1': 'FUTV', '3': 'TDmas 1', '4': 'Teletica', '5': 'Canal 6', '6': 'Multimedios', '7': 'Subida', '10': 'Disney 8', '11': 'FUTV URL', '12': 'TIGO SRT', '13': 'TELETICA URL', '14': 'TDMAS 1 URL', '15': 'CANAL 6 URL', '16': 'DISNEY 7 SRT', '17': 'FUTV ALTERNO', '18': 'FUTV SRT', '19': 'RANDOM Disney 7', '20': 'CANAL 6 SRT', '21': 'TELETICA SRT', '22': 'FOX+ SRT', '23': 'FOX SRT', '24': 'FOX+ URL', '25': 'FOX URL', '26': 'FOX+ ALTERNO', '27': 'Canal 8 URL', '28': 'Canal 2 URL' };
    const procName = channelLabels[String(process_id)] || `Proceso ${process_id}`;
    sendLog(process_id, 'info', outputProfile.passthrough
      ? `🎬 ${procName}: Perfil PASSTHROUGH → -c copy (sin re-encode, calidad original del CDN)${isRecovery ? ' [recovery]' : ''}`
      : `🎬 ${procName}: Perfil ${outputProfile.label} → ${outputProfile.width}p CBR ${outputProfile.videoBitrate} AAC${outputProfile.audioBitrate} GOP2s (preset ${outputProfile.preset || 'veryfast'}${outputProfile.x264Params ? ' +x264params' : ''})${isRecovery ? ' [recovery]' : ''}`);

    // Procesos CFR: usar fps nativo (29.97) + vsync cfr para cadencia constante al RTMP
    // Esto evita micro-jitter por forzar 30fps en una fuente 29.97fps (frame duplicado cada ~33s)
    const isCfrOutput = CFR_OUTPUT_PROCESSES.has(String(process_id));
    let outputFps = isCfrOutput ? '29.97' : '30';
    let gopSize  = isCfrOutput ? '59.94' : '60'; // GOP = 2 segundos a fps nativo

    // 🎯 Auto-detección de FPS de la fuente vía ffprobe.
    // Mapea al estándar limpio más cercano (23.976/24/25/29.97/30/50/59.94/60)
    // para que la salida coincida con el ingreso y evitemos frames duplicados/perdidos.
    // Solo aplica a fuentes HTTP/HTTPS reales (no SRT/RTMP/passthrough/Tigo proxy).
    const canProbeFps = !isPassthroughBlock
      && !isSrtIngest
      && !isRtmpInputSource
      && !isTigoHdmiProcess
      && typeof inputSourceUrl === 'string'
      && /^https?:\/\//i.test(inputSourceUrl);
    if (canProbeFps) {
      try {
        const probeRes = await detectSourceFps(inputSourceUrl, combinedHeaders, sessionUserAgent, refererDomain);
        if (probeRes && probeRes.fps) {
          outputFps = String(probeRes.fps);
          gopSize   = String(probeRes.gop);
          sendLog(process_id, 'info', `🎯 FPS auto-detectado: fuente ${probeRes.rawFps} → salida ${outputFps}fps (GOP ${gopSize})`);
        } else {
          sendLog(process_id, 'info', `🎯 FPS auto-detect: sin dato → fallback ${outputFps}fps`);
        }
      } catch (e) {
        sendLog(process_id, 'warn', `🎯 FPS auto-detect falló: ${e.message} → fallback ${outputFps}fps`);
      }
    }

    // Saneo de timestamps para evitar audio repetido / saltos hacia atrás
    // y reloads del player por EXT-X-DISCONTINUITY.
    // Canal 6 URL (15) requiere el mismo saneo que los scrapeados, pero con salida 30fps.
    const isHlsTimestampFix = ['1', '3', '4', '5', '11', '13', '14', '15', '17', '18', '24', '25'].includes(String(process_id));
    const fflags = isHlsTimestampFix
      ? '+genpts+discardcorrupt+igndts'
      : (isUnivisionLikeSource || isAkamaiSource) ? '+genpts+discardcorrupt' : '+genpts';

    // Sin buffer especial por canal: mantener entrada HLS lo más lineal posible.
    const inputSmoothingArgs = [];

    ffmpegArgs = [
      ...inputArgs,
      ...hardenedLiveInputArgs,
      '-fflags', fflags,
      '-analyzeduration', (isUnivisionLikeSource || isAkamaiSource || isProxyScrapedSource) ? '10000000' : analyzeDuration,  // 10s para VLC-like profiles + proxy
      '-probesize', (isUnivisionLikeSource || isAkamaiSource || isProxyScrapedSource) ? '5000000' : probeSize,               // 5MB para VLC-like profiles + proxy
      ...inputSmoothingArgs,
      '-i', inputSourceUrl,
      // Univision: auto-selección + skip subtítulos EIA-608
      // Scrapeados: map por programa HLS
      // Otros: map genérico video+audio
      ...(isUnivisionLikeSource
        ? ['-map', '0:v:3?', '-map', '0:a:3?', '-sn']  // Stream #0:10 (720p Program 3) + Audio #0:9
        : hlsProgramIndex >= 0
        ? ['-map', `0:p:${hlsProgramIndex}:v?`, '-map', `0:p:${hlsProgramIndex}:a?`]
        : ['-map', '0:v:0?', '-map', '0:a:0?']),
      // ── Codec args: PASSTHROUGH (-c copy) o re-encode libx264 ──
      // PASSTHROUGH: cuando el usuario elige el perfil 'passthrough' en la UI
      // (por defecto activo en Canal 8/Canal 2), salimos con `-c copy`. Sin
      // re-encode, CPU ~3% y calidad original del CDN preservada. Requiere
      // que la fuente entregue H264+AAC (caso estándar Telecable).
      ...(outputProfile.passthrough ? [
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-bsf:v', 'h264_mp4toannexb',
        '-max_muxing_queue_size', '1024',
        '-reset_timestamps', '1',
      ] : [
        '-c:v', 'libx264',
        '-preset', outputProfile.preset || 'veryfast',
        '-profile:v', 'main',
        '-threads', '4',
        '-b:v', outputProfile.videoBitrate,
        '-maxrate', outputProfile.videoBitrate,
        '-bufsize', outputProfile.bufsize,
        ...(outputProfile.x264Params ? ['-x264-params', outputProfile.x264Params] : []),
        '-vf', isCanal6UrlProcess ? `scale=-2:${outputProfile.width},fps=30` : `scale=-2:${outputProfile.width}`,
        '-r', outputFps,
        ...(isCfrOutput || isCanal6UrlProcess ? ['-vsync', 'cfr'] : []),
        '-g', gopSize,
        '-keyint_min', gopSize,
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', outputProfile.audioBitrate,
        '-ar', '44100',
        '-max_muxing_queue_size', '1024',
        '-reset_timestamps', '1',
      ]),
    ];

    // Forzar timestamps monotónicos a la salida + resync suave de audio.
    // make_zero: si llega un PTS negativo, lo pone en 0 y sigue lineal (nunca retrocede).
    // -async 1: ajusta drift de audio sin pegar saltos audibles.
    if (isHlsTimestampFix) {
      ffmpegArgs.push('-avoid_negative_ts', 'make_zero', '-async', '1');
      sendLog(process_id, 'info', `🕒 HLS timestamp fix: +genpts+igndts+discardcorrupt / avoid_negative_ts=make_zero / async=1${isCanal6UrlProcess ? ' / fps=30+cfr' : ''}`);
    }

    // ── MODOS DE SALIDA (RANDOM Disney 7 ID 19) ─────────────────────────
    // 'rawvideo'  → ÚNICO modo activo en UI: video CRUDO (-c:v copy) + audio
    //               re-encodeado a AAC 128k 48kHz estéreo. Mantiene calidad
    //               original del video y garantiza audio compatible con Xui /
    //               IPTV Smarters Pro (muchos M3U traen AC3/MP2/HE-AAC que no
    //               decodifican bien en clientes IPTV → "video sin sonido").
    // 'copy'      → -c copy puro (legacy, oculto en UI).
    // 'smart'     → probe de codecs: copy si compatible, transcode mínimo (legacy).
    // 'transcode' → no toca este bloque; usa el perfil estándar de arriba.
    if (isPassthroughBlock) {
      const transcodeFlagsToStrip = new Set([
        '-c:v', '-preset', '-profile:v', '-threads',
        '-b:v', '-maxrate', '-bufsize',
        '-vf', '-r', '-vsync',
        '-g', '-keyint_min', '-sc_threshold',
        '-c:a', '-b:a', '-ar',
        '-max_muxing_queue_size', '-reset_timestamps',
      ]);
      const stripped = [];
      for (let i = 0; i < ffmpegArgs.length; i++) {
        if (transcodeFlagsToStrip.has(ffmpegArgs[i])) { i++; continue; }
        stripped.push(ffmpegArgs[i]);
      }
      // Por defecto (modo 'copy'): copy puro.
      let videoOut = ['-c:v', 'copy'];
      let audioOut = ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'];

      if (normalizedMode === 'rawvideo') {
        // Video crudo, audio siempre re-encodeado a AAC estéreo 48kHz.
        // Esto resuelve el problema de "sin audio" en IPTV Smarters cuando
        // el origen viene en AC3/EAC3/MP2/HE-AACv2 (códecs que XUI/Smarters
        // no demuxean bien dentro de TS via HLS).
        videoOut = ['-c:v', 'copy'];
        audioOut = [
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '48000',
          '-ac', '2',
          '-aac_coder', 'twoloop',
        ];
        sendLog(process_id, 'info', `🎧 RAWVIDEO: video crudo (-c:v copy) + audio AAC 128k/48kHz estéreo (compat Xui/Smarters)`);
      } else if (normalizedMode === 'smart') {
        // Probe del origen para decidir per-stream. Construir headers HTTP.
        const probeHeaderStr = (combinedHeaders && typeof combinedHeaders === 'string') ? combinedHeaders : '';
        const probeUA = customUserAgent || sessionUserAgent || '';
        const probeRef = customReferer || refererDomain || '';
        sendLog(process_id, 'info', `🔍 Modo SMART: analizando codecs del origen...`);
        const codecs = await detectSourceCodecs(effectiveSourceM3u8 || source_m3u8, probeHeaderStr, probeUA, probeRef);
        const v = codecs.videoCodec;
        const a = codecs.audioCodec;
        sendLog(process_id, 'info', `🔬 Probe: video=${v || '?'} audio=${a || '?'}`);

        // Video: copy si ya es H.264 (avc1/h264). Sino, transcodear a H.264 baseline-friendly.
        if (v === 'h264' || v === 'avc1') {
          videoOut = ['-c:v', 'copy'];
        } else {
          videoOut = [
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p',
            '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
          ];
          sendLog(process_id, 'warn', `⚙️  Video '${v || '?'}' no es H.264 → transcodeando a libx264`);
        }

        // Audio: copy si ya es AAC. Sino, transcodear a AAC 128k.
        if (a === 'aac') {
          audioOut = ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'];
        } else if (!a) {
          // No detectado: dejar copy y que FFmpeg falle visiblemente si hay problema
          audioOut = ['-c:a', 'copy'];
        } else {
          audioOut = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000'];
          sendLog(process_id, 'warn', `⚙️  Audio '${a}' no es AAC → transcodeando a AAC 128k`);
        }
      }

      ffmpegArgs = [...stripped, ...videoOut, ...audioOut];
      const modeLabel = normalizedMode === 'smart'
        ? 'SMART (copy compatible)'
        : normalizedMode === 'rawvideo'
          ? 'RAWVIDEO (video crudo + AAC)'
          : 'COPY puro';
      sendLog(process_id, 'success', `🎯 Modo ${modeLabel}: salida HLS lista`);
    }

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
      // ── EMPALME SIN CORTE desde FILLER (sólo FOX/FOX+ URL 24/25) ──
      // Si el filler "RECONECTANDO" está activo, lo detenemos y NO wipeamos
      // la carpeta: dejamos que el nuevo FFmpeg LIVE haga append al mismo
      // playlist (epoch + append_list garantizan numeración monotónica).
      // Así los clientes pasan de pantalla filler → señal en vivo sin tener
      // que reabrir el manifest.
      const fillerWasActive = foxIsFillerSupported(process_id) && foxIsFillerActive(process_id);
      if (fillerWasActive) {
        try { await foxStopFillerAndWait(process_id, sendLog); } catch (_) {}
        sendLog(process_id, 'info', `🎞️ FILLER → LIVE: empalme sin wipe (clientes mantienen sesión HLS)`);
      }
      // ── WIPE AGRESIVO de la carpeta HLS antes de arrancar FFmpeg ──
      // CRÍTICO: en este punto el FFmpeg viejo (si existía) ya fue matado y
      // esperado en líneas 2041-2042 (waitForProcessDeath escala a SIGKILL),
      // así que no quedan file handles abiertos sobre estos .ts/.m3u8.
      // Borramos TODA la carpeta de raíz (recursive) en vez de unlink por
      // archivo: evita que XUI pull un manifest con segmentos viejos
      // mezclados con timestamps nuevos (causa raíz del "loop" tras caídas).
      if (!fillerWasActive) {
        try {
          if (fs.existsSync(hlsDir)) {
            fs.rmSync(hlsDir, { recursive: true, force: true });
          }
        } catch (e) {
          sendLog(process_id, 'warn', `⚠️ No se pudo borrar ${hlsDir}: ${e.message} (FFmpeg sobreescribirá igual)`);
        }
      }
      try {
        fs.mkdirSync(hlsDir, { recursive: true });
      } catch (_) {}
      if (!fillerWasActive) {
        sendLog(process_id, 'info', `🧹 Carpeta HLS limpiada: ${hlsDir} (sin segmentos viejos)`);
      }

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
      const slug = HLS_SLUG_MAP[process_id] || `stream_${process_id}`;
      sendLog(process_id, 'success', `🛰️ SRT ingest activo (1 solo proceso): srt://0.0.0.0:${cfg.port} → /live/${slug}/playlist.m3u8 (${encInfo}, latency=${cfg.latencyMs}ms, perfil ${cfg._lastProfile || 'default'})`);
    } else if (LEGACY_SOCKS_FFMPEG_PROCESSES.has(process_id)) {
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

    if (!ffmpegProcess && spawnCmd === 'ffmpeg' && isViaCrTunnel(process_id)) {
      [spawnCmd, spawnArgs] = wrapFfmpegSpawn(process_id, ffmpegArgs);
      sendLog(process_id, 'info', `🇨🇷 FFmpeg saldrá vía túnel WireGuard CR (http_proxy ${LOCAL_PROXY_URL})`);
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
    // En modo Telecable (cualquier pid) el upstream es HLS firmado: NO keepalive.
    const skipKeepAliveForTelecable = isTelecableMode(process_id);
    if (PROXY_PROCESSES.has(String(process_id)) && !isTigoHdmiMode && !skipKeepAliveForTelecable) {
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
          updateLiveStats(process_id, trimmed);
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
          updateLiveStats(process_id, trimmed);
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
    // DEPRECATED (May 2026): ahora `startSrtIngest` hace listener+encoder
    // en UN solo FFmpeg que escribe directo a /live/<slug>/playlist.m3u8.
    // No hay buffer intermedio ni ETAPA 2. Bloque deshabilitado.
    if (false && isSrtIngestMode) {
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
        const spawnSrtOutputStage = async () => {
          if (manualStopProcesses.has(process_id) || manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
            return;
          }
          const ingestProc = ffmpegProcesses.get(process_id);
          if (!ingestProc || !ingestProc.process || ingestProc.process.killed) {
            sendLog(process_id, 'warn', `⚠️ ${cfg.label} ETAPA 2: ETAPA 1 no está viva, abortando spawn`);
            return;
          }

          const outPlaylist = path.join(outDir, 'playlist.m3u8');
          // Perfil unificado para TODOS los SRT ingest (incluido Disney 7 ID 16):
          // CBR 2000k 720p30 AAC128k veryfast — mismo perfil que FUTV ALTERNO.
          // 2000k es suficiente para verse "super bien" en SRT confiable y reduce
          // carga de upload sin pérdida visible vs 3500k.
          const stageProfile = getOutputProfileConfig(getStoredOutputProfile(process_id));
          const vBitrate = stageProfile.videoBitrate;
          const vBufsize = stageProfile.bufsize;
          const vHeight = stageProfile.width;
          const aBitrate = stageProfile.audioBitrate;
          const vPreset  = stageProfile.preset || 'veryfast';
          // 🎯 Auto-detección de FPS del buffer SRT (lo que OBS está enviando).
          let srtFps = '30';
          let srtGop = '60';
          try {
            const probeRes = await detectSourceFps(cfg.bufferPlaylist);
            if (probeRes && probeRes.fps) {
              srtFps = String(probeRes.fps);
              srtGop = String(probeRes.gop);
              sendLog(process_id, 'info', `🎯 ${cfg.label} FPS auto-detectado: OBS ${probeRes.rawFps} → salida ${srtFps}fps`);
            }
          } catch (_) {}
          const stage2Args = [
            '-re',
            '-fflags', '+genpts+discardcorrupt',
            '-analyzeduration', '3000000',
            '-probesize', '1500000',
            '-rw_timeout', '15000000',
            '-i', cfg.bufferPlaylist,
            '-map', '0:v:0?',
            '-map', '0:a:0?',
            '-c:v', 'libx264',
            '-preset', vPreset,
            '-profile:v', 'main',
            '-threads', '4',
            '-b:v', vBitrate,
            '-maxrate', vBitrate,
            '-bufsize', vBufsize,
            ...(stageProfile.x264Params ? ['-x264-params', stageProfile.x264Params] : []),
            '-vf', `scale=-2:${vHeight}`,
            '-r', srtFps,
            '-vsync', 'cfr',
            '-g', srtGop,
            '-keyint_min', srtGop,
            '-sc_threshold', '0',
            '-c:a', 'aac',
            '-b:a', aBitrate,
            '-ar', '48000',
            '-max_muxing_queue_size', '1024',
            '-reset_timestamps', '1',
            '-f', 'hls',
            '-hls_time', '4',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments+independent_segments',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
            '-hls_allow_cache', '1',
            '-hls_start_number_source', 'epoch',
            outPlaylist,
          ];
          const stage2 = spawn('ffmpeg', stage2Args);
          tigoOutputProcesses.set(String(process_id), stage2);
          sendLog(process_id, 'success', `🎬 ${cfg.label} BUFFER ETAPA 2 → /live/${slug}/playlist.m3u8 (perfil ${stageProfile.label}: ${vHeight}p CBR ${vBitrate} @ ${srtFps}fps, preset ${vPreset})`);

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

    // ── Detector de "404 storm de playlist" (Canal 6 / ID 5 y 15) ──
    // CloudFront a veces deja la URL viva pero el manifest apunta a una
    // ventana de segmentos vacía → FFmpeg entra en bucle infinito de
    // "HTTP error 404" + "Failed to reload playlist 0" SIN salir nunca.
    // Watchdog tampoco salta porque técnicamente sigue vivo.
    // Solución: si vemos 6+ "Failed to reload playlist" en ≤8s → matar
    // FFmpeg para que la auto-recovery dispare un scrape NUEVO (y, al 2º
    // intento, fallback a Multimedios — lógica ya existente).
    const playlist404State = {
      count: 0,
      windowStart: Date.now(),
      restartTriggered: false,
    };
    const PLAYLIST_404_WINDOW_MS = 8_000;
    const PLAYLIST_404_THRESHOLD = 6;
    const isCanal6Stream = process_id === '5';

    // ── FOX URL (25) / FOX+ URL (24): kill ULTRA-rápido en 404 de playlist ──
    // Estos canales usan URL de TDMax (cdn12.teletica.com). Cuando el token o
    // la sesión expira, el playlist responde 404 inmediato. Esperar al watchdog
    // (75s) o al detector Canal 6 (6 fails / 8s) deja a los clientes con
    // pantalla negra muchos segundos. Aquí cortamos al 2º "Failed to reload
    // playlist" dentro de 5s → mata FFmpeg, invalida cache, fuerza scrape
    // fresco vía la auto-recovery existente (Quick Retry + full re-scrape).
    const foxUrlFast404State = {
      count: 0,
      windowStart: Date.now(),
      restartTriggered: false,
    };
    const FOX_URL_404_WINDOW_MS = 5_000;
    const FOX_URL_404_THRESHOLD = 2;
    const isFoxUrlScrapedStream = process_id === '24' || process_id === '25';

    // Manejar errores con análisis mejorado
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Guardar en buffer circular para diagnóstico
      const lines = output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        stderrBuffer.push(line.trim());
        if (stderrBuffer.length > MAX_STDERR_LINES) stderrBuffer.shift();
        updateLiveStats(process_id, line);
      }

      // ── Canal 6: detector de 404 storm de playlist ──
      if (isCanal6Stream && !playlist404State.restartTriggered) {
        const reloadFails = (output.match(/Failed to reload playlist/g) || []).length;
        if (reloadFails > 0) {
          const now = Date.now();
          if (now - playlist404State.windowStart > PLAYLIST_404_WINDOW_MS) {
            playlist404State.windowStart = now;
            playlist404State.count = 0;
          }
          playlist404State.count += reloadFails;
          if (playlist404State.count >= PLAYLIST_404_THRESHOLD) {
            playlist404State.restartTriggered = true;
            sendLog(process_id, 'error', `🚨 Canal 6: 404-storm de playlist (${playlist404State.count} fails en ${Math.round((now - playlist404State.windowStart)/1000)}s) → matando FFmpeg para forzar scrape nuevo`);
            try {
              scrapeSessionCache.delete(process_id);
              if (typeof ffmpegProcess.kill === 'function') {
                ffmpegProcess.kill('SIGTERM');
                setTimeout(() => {
                  try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
                }, 3000);
              }
            } catch (e) {
              console.error('Error en 404-storm restart:', e);
            }
            return;
          }
        }
      }

      // ── FOX URL / FOX+ URL: fast-kill en 404 de playlist ──
      if (isFoxUrlScrapedStream && !foxUrlFast404State.restartTriggered) {
        const reloadFails = (output.match(/Failed to reload playlist/g) || []).length;
        if (reloadFails > 0) {
          const now = Date.now();
          if (now - foxUrlFast404State.windowStart > FOX_URL_404_WINDOW_MS) {
            foxUrlFast404State.windowStart = now;
            foxUrlFast404State.count = 0;
          }
          foxUrlFast404State.count += reloadFails;
          if (foxUrlFast404State.count >= FOX_URL_404_THRESHOLD) {
            foxUrlFast404State.restartTriggered = true;
            sendLog(process_id, 'error', `⚡ FOX URL: 404 de playlist (${foxUrlFast404State.count} fails en ${Math.round((now - foxUrlFast404State.windowStart)/1000)}s) → fast-kill para scrape inmediato`);
            try {
              scrapeSessionCache.delete(process_id);
              // Invalidar lastKnownStreamState para que la recovery NO use Quick
              // Retry con la URL muerta — debe ir directo a scrape fresco.
              try { lastKnownStreamState.delete(String(process_id)); } catch (_) {}
              try { quickRetryState.set(process_id, Date.now()); } catch (_) {}
              if (typeof ffmpegProcess.kill === 'function') {
                ffmpegProcess.kill('SIGTERM');
                setTimeout(() => {
                  try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
                }, 2000);
              }
            } catch (e) {
              console.error('Error en FOX URL fast-kill:', e);
            }
            return;
          }
        }
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
          healthRecordGap(process_id);
          const sev = healthGapSeverity(process_id);
          sendLog(process_id, 'info', `⚠️ Gap detectado — ${sev.emoji} ${sev.label} (${sev.hint})`);
        } else if (/Connection timed out|Operation timed out/.test(output) && !/frame=/.test(output)) {
          sendLog(process_id, 'info', `🌐 Jitter SOCKS5 (timeout transitorio)`);
        }
      }

      // 1) Clasificar primero causas reales (aunque no contengan "error/failed")
      const wasCategorized = detectAndCategorizeError(output, process_id);
      if (wasCategorized) return;
      
      // Detectar diferentes tipos de mensajes
      if (output.includes('frame=') || output.includes('fps=')) {
        // Progreso normal — actualizar watchdog SOLO si el contador de frames avanzó.
        // FFmpeg sigue imprimiendo "frame=N fps=X" con N congelado cuando el input
        // se queda sin data (bitrate=N/A). Sin esto el watchdog cree que todo va
        // bien y el canal queda "colgado vivo" hasta reinicio manual.
        const _frameNumMatch = output.match(/frame=\s*(\d+)/);
        const _currentFrameNum = _frameNumMatch ? parseInt(_frameNumMatch[1], 10) : null;
        const _prevFrameNum = lastFrameNumber.get(process_id);
        if (_currentFrameNum === null || _prevFrameNum === undefined || _currentFrameNum > _prevFrameNum) {
          lastFrameTime.set(process_id, Date.now());
          if (_currentFrameNum !== null) lastFrameNumber.set(process_id, _currentFrameNum);
        }
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
          healthRecordFrame(process_id, parseInt(frameMatch[1], 10));
          if (now - lastLog >= PROGRESS_LOG_INTERVAL) {
            lastProgressLog.set(process_id, now);
            const bitrateTxt = bitrateMatch ? `${bitrateMatch[1]}kbps` : 'N/A';
            sendLog(process_id, 'info', healthFormatProgress(process_id, frameMatch[1], fpsMatch[1], bitrateTxt));
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
      if (ignoredLateCloseProcesses.has(ffmpegProcess)) {
        sendLog(process_id, 'info', `ℹ️ Close tardío de FFmpeg reemplazado por watchdog (pid ${ffmpegProcess.pid}) ignorado`);
        return;
      }
      // Detener keep-alive de Tigo (si estaba activo) — evita fugas de timers
      stopTigoKeepAlive(process_id);
      // Si Tigo BUFFER estaba activo, matar también la ETAPA 2 (transcoder local)
      stopTigoOutputStage(process_id);
      // Resetear métricas SRT (modo HDMI)
      if (String(process_id) === '12') resetTigoSrtMetric(process_id);
      const processInfo = ffmpegProcesses.get(process_id);
      // GUARD anti-condición de carrera: si el mapa ya tiene OTRO ffmpeg
      // (porque un /api/emit/restart o /api/emit nuevo tomó el slot mientras
      // este close llegaba tarde), NO debemos tocar el estado ni Supabase,
      // o apagaríamos el proceso recién arrancado.
      const stillOurs = !processInfo || processInfo.process === ffmpegProcess;
      if (!stillOurs) {
        sendLog(process_id, 'info', `ℹ️ Close tardío de FFmpeg viejo (pid ${ffmpegProcess.pid}) ignorado — un proceso nuevo ya tomó el slot`);
        return;
      }
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

      // ─────────────────────────────────────────────────────────────────
      // PI5 SRT INGEST — MODO LISTENER PERMANENTE (IDs 21/22/23)
      // ─────────────────────────────────────────────────────────────────
      // Cuando el FFmpeg listener cae por desconexión del Pi5, glitch de
      // red del VPS, o EOF del caller, NO debemos:
      //   • marcar is_emitting=false (el switch del tab se apagaría)
      //   • contar la caída contra el circuit breaker
      //   • esperar 2 min al watchdog always-on
      // En su lugar, respawneamos el listener en 2s vía /api/emit interno
      // (mismo payload que usa el watchdog always-on) manteniendo el
      // estado "encendido" para que el Pi5 reconecte solo cuando vuelva.
      if (!isManualStop && PI_SRT_INGEST_PROCESSES.has(String(process_id))) {
        const cfgPi5 = getSrtConfig(String(process_id));
        const labelPi5 = cfgPi5?.label || `SRT ${process_id}`;
        sendLog(process_id, 'warn', `🛰️ ${labelPi5}: listener cayó (code=${code ?? '-'}${signal ? `, signal=${signal}` : ''}, runtime=${Math.floor(runtime/1000)}s) — respawn persistente en 2s. El Pi5 reconectará solo.`);

        // Limpiar handles del proceso muerto sin tocar is_emitting
        emissionStatuses.set(process_id, 'starting');
        ffmpegProcesses.delete(process_id);
        lastFrameTime.delete(process_id); lastFrameNumber.delete(process_id);
        ignoredLateCloseProcesses.delete(ffmpegProcess);
        try { resetTigoSrtMetric(process_id); } catch (_) {}

        // Resetear contadores para que el circuit breaker no se acumule
        try { failureTimestamps.delete(String(process_id)); } catch (_) {}
        try { recoveryAttempts.set(String(process_id), 0); } catch (_) {}
        try { quickRetryState.delete(process_id); } catch (_) {}
        autoRecoveryInProgress.set(String(process_id), false);

        // Mantener is_emitting=true en BD para que el switch siga ON
        if (supabase) {
          try {
            await supabase.from('emission_processes').update({
              is_active: true,
              is_emitting: true,
              emit_status: 'starting',
              failure_reason: null,
              failure_details: null,
              start_time: 0,
              ffmpeg_pid: null,
            }).eq('id', parseInt(process_id));
          } catch (e) {
            sendLog(process_id, 'warn', `⚠️ No se pudo mantener is_emitting=true: ${e.message}`);
          }
        }

        // Respawn vía /api/emit interno (con guard anti-doble-arranque)
        setTimeout(async () => {
          if (manualStopProcesses.has(String(process_id)) || manualStopProcesses.has(Number(process_id))) {
            sendLog(process_id, 'info', `🛑 Respawn cancelado: parada manual detectada`);
            return;
          }
          if (ffmpegProcesses.has(process_id) || ffmpegProcesses.has(String(process_id))) {
            sendLog(process_id, 'info', `ℹ️ Respawn omitido: listener ya levantado`);
            return;
          }
          try {
            await fetch(`http://localhost:${PORT}/api/emit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source_m3u8: 'srt://obs',
                target_rtmp: 'hls-local',
                process_id: String(process_id),
                is_recovery: true,
              }),
            });
          } catch (e) {
            sendLog(process_id, 'error', `❌ Respawn SRT listener falló: ${e.message} — watchdog always-on lo levantará en ≤2 min`);
          }
        }, 2000);

        return;
      }

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

      lastFrameTime.delete(process_id); lastFrameNumber.delete(process_id); // Limpiar watchdog

      // ──────────────────────────────────────────────────────────────────
      // FOX / FOX+ URL (24/25): arrancar FILLER inmediatamente
      // ──────────────────────────────────────────────────────────────────
      // Mostramos la pantalla "RECONECTANDO · Media TV" durante la
      // ventana de re-scrape. El playlist HLS sigue creciendo en la misma
      // carpeta /live/<slug>/, así los clientes (XUI/players) NO ven
      // "señal perdida". Cuando el nuevo FFmpeg LIVE arranque, se
      // empalma sin wipe (ver bloque isHlsOutput arriba).
      if (!isManualStop && foxIsFillerSupported(process_id)) {
        foxStartFiller(process_id, sendLog);
      } else if (isManualStop && foxIsFillerSupported(process_id) && foxIsFillerActive(process_id)) {
        foxStopFillerAndWait(process_id, sendLog).catch(()=>{});
      }

      // AUTO-RECOVERY: Para canales con scraping (usa CHANNEL_MAP global)

      if (isManualStop) {
        sendLog(process_id, 'info', '🛑 Parada manual detectada - Auto-recovery desactivado');
        quickRetryState.delete(process_id);
      } else if (String(process_id) === '17' && (code !== null || signal)) {
        // ───────────────────────────────────────────────────────────────
        // FAILOVER ALTERNO (17) → FUTV URL (11)
        // Si ALTERNO cae por cualquier motivo (404 de origen TDMax, token
        // expirado, EOF, kill), NO reintentamos ALTERNO en bucle: levantamos
        // FUTV URL (11) que tiene su propio scrape fresco con channel_id
        // estable. Respeta paradas manuales y no se dispara si FUTV URL ya
        // está activo. One-shot: FUTV URL maneja su propio recovery sin
        // re-escalar a nada.
        // ───────────────────────────────────────────────────────────────
        const detectedAlt = detectedErrors.get(process_id);
        const altReason = detectedAlt?.reason || (code === 0 ? 'EOF' : `exit ${code}`);
        sendLog(process_id, 'error', `🚨 FUTV ALTERNO caído (${altReason}) — escalando a FUTV URL (failover automático)`);
        // Limpiar estado ALTERNO para que NO siga reintentando solo
        quickRetryState.delete(process_id);
        recoveryAttempts.delete(process_id);
        failureTimestamps.delete(String(process_id));
        // Disparar FUTV URL (11) — autoRecoverChannel hace scrape fresco con channel_id estable
        setTimeout(async () => {
          try {
            // Verificar que FUTV URL (11) no esté ya emitiendo
            const futvUrlStatus = emissionStatuses.get('11');
            const futvUrlAlive = ffmpegProcesses.has('11') || futvUrlStatus === 'running' || futvUrlStatus === 'starting';
            if (futvUrlAlive) {
              sendLog(process_id, 'info', `ℹ️ Failover omitido: FUTV URL (11) ya está activo`);
              return;
            }
            // Respetar parada manual del usuario sobre FUTV URL
            if (manualStopProcesses.has('11') || manualStopProcesses.has(11)) {
              sendLog(process_id, 'warn', `⚠️ Failover omitido: FUTV URL (11) tiene parada manual activa`);
              return;
            }
            sendLog(process_id, 'info', `🔄 Failover: arrancando FUTV URL (11) con scrape fresco...`);
            await autoRecoverChannel('11', '641cba02e4b068d89b2344e3', 'FUTV URL');
          } catch (e) {
            sendLog(process_id, 'error', `❌ Failover ALTERNO→FUTV URL falló: ${e.message}`);
          }
        }, 1000);
      } else if (code !== null || signal) {
        // Auto-recovery para CUALQUIER cierre no manual (código de salida o señal como SIGKILL del watchdog)
        const isCleanExit = code === 0;
        if (isCleanExit) {
          sendLog(process_id, 'warn', `⚠️ FFmpeg salió con código 0 (fuente expirada o EOF) - Intentando auto-recovery...`);
        }

        // === CIRCUIT BREAKER: registrar fallo y verificar si estamos en tormenta ===
        recordFailure(process_id);
        if (shouldCircuitBreakProcess(process_id)) {
          sendLog(process_id, 'error', `🔴 CIRCUIT BREAKER: ${CIRCUIT_BREAKER_MAX_FAILURES}+ caídas en ${CIRCUIT_BREAKER_WINDOW_MS / 60000} min. Recovery DETENIDO para evitar saturación del servidor.`);
          if (supabase) {
            await supabase.from('emission_processes').update({
              is_active: false, is_emitting: false, emit_status: 'error',
              failure_reason: 'circuit_breaker',
              failure_details: `Demasiadas caídas consecutivas (${CIRCUIT_BREAKER_MAX_FAILURES} en ${CIRCUIT_BREAKER_WINDOW_MS / 60000} min). Reiniciar manualmente.`
            }).eq('id', parseInt(process_id));
          }
          // No reintentar automáticamente aunque esté "Encendido siempre": cuando TDMax
          // cambia login/loadbalancer, cada relanzamiento vuelve a fallar y puede disparar
          // cientos de scrapes. El usuario debe revisar y arrancar manualmente.
          autoRecoveryInProgress.set(String(process_id), false);
          quickRetryState.delete(String(process_id));
          recoveryAttempts.set(String(process_id), 0);
          // No hacer recovery y dejar el proceso muerto para evitar saturación.
        } else {
        
        // MEJORA #2: Retry con misma URL antes de recovery completo
        // Para canales scrapeados (1-6, 8, 9), intentar primero con la misma URL
        // ya que muchas caídas son micro-cortes del CDN donde la URL sigue válida
        const shouldRetryFirst = !!CHANNEL_MAP[process_id] && !QUICK_RETRY_DISABLED_PROCESSES.has(String(process_id));
        const lastQuickRetryAt = quickRetryState.get(process_id) || 0;
        const quickRetryRecentlyFailed = lastQuickRetryAt > 0 && (Date.now() - lastQuickRetryAt) < 30000;

        if (CHANNEL_MAP[process_id] && QUICK_RETRY_DISABLED_PROCESSES.has(String(process_id))) {
          sendLog(process_id, 'info', '🔁 RETRY RÁPIDO omitido: URL con token corto, se hará scraping fresco directo');
        }

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
                    const fresh = await scrapeStreamUrlLocal(channelId, channelName, { useProxy: true, account: accountForProcess(process_id), processId: String(process_id) });
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
                const retryOutputProfile = rememberedState?.output_profile || getStoredOutputProfile(process_id);
                rememberStreamState(process_id, { source_m3u8: retrySourceUrl, target_rtmp: retryTargetRtmp, output_profile: retryOutputProfile });
                // Reiniciar con misma URL (o fresca si es proxy)
                const emitUrl = `http://localhost:${PORT}/api/emit`;
                const emitResp = await fetch(emitUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: retrySourceUrl,
                    target_rtmp: retryTargetRtmp,
                    process_id: process_id,
                    output_profile: retryOutputProfile,
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
                    if (String(process_id) === '13' && getTeleticaSourceMode('13') === 'official') {
                      setTeleticaSourceMode('13', 'scraping');
                      sendLog('13', 'warn', '⚠️ Fuente OFICIAL Teletica falló en RETRY — cambiando AUTOMÁTICAMENTE a modo SCRAPING');
                    }
                    await autoRecoverChannel(process_id, channelId, channelName);
                  }
                }
              } else {
                sendLog(process_id, 'warn', `⚠️ RETRY: No hay URL/RTMP guardados ni en base ni en memoria, saltando a recovery completo`);
                if (CHANNEL_MAP[process_id]) {
                  const { channelId, channelName } = CHANNEL_MAP[process_id];
                  if (String(process_id) === '13' && getTeleticaSourceMode('13') === 'official') {
                    setTeleticaSourceMode('13', 'scraping');
                    sendLog('13', 'warn', '⚠️ Fuente OFICIAL Teletica falló (sin URL guardada) — cambiando AUTOMÁTICAMENTE a modo SCRAPING');
                  }
                  await autoRecoverChannel(process_id, channelId, channelName);
                }
              }
            } catch (retryErr) {
              sendLog(process_id, 'error', `❌ RETRY error: ${retryErr.message}, iniciando recovery completo...`);
              if (CHANNEL_MAP[process_id]) {
                const { channelId, channelName } = CHANNEL_MAP[process_id];
                if (String(process_id) === '13' && getTeleticaSourceMode('13') === 'official') {
                  setTeleticaSourceMode('13', 'scraping');
                  sendLog('13', 'warn', '⚠️ Fuente OFICIAL Teletica falló en RETRY (excepción) — cambiando AUTOMÁTICAMENTE a modo SCRAPING');
                }
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
              return;
            }
            // TELETICA URL (13): 2 reintentos en OFICIAL antes de cambiar a SCRAPING.
            //   - Si runtime > 60s, se considera "estable" → reset del contador.
            //   - Mientras failures < 2: re-emitir con URL oficial (Bradmax).
            //   - Al alcanzar 2 reintentos fallidos: flip a SCRAPING para el recovery
            //     (fallback unidireccional; de scraping NUNCA se promueve a oficial).
            if (process_id === '13' && getTeleticaSourceMode('13') === 'official') {
              if (runtime > 60000) teleticaOfficialFailures.set('13', 0);
              const failed = (teleticaOfficialFailures.get('13') || 0) + 1;
              teleticaOfficialFailures.set('13', failed);
              if (failed <= TELETICA_OFFICIAL_MAX_RETRIES) {
                sendLog('13', 'warn', `🔁 Fuente OFICIAL Teletica falló — reintento ${failed}/${TELETICA_OFFICIAL_MAX_RETRIES} con Bradmax CDN antes de cambiar a SCRAPING...`);
                try {
                  let targetRtmp = 'hls-local';
                  if (supabase) {
                    const { data: rowTel } = await supabase
                      .from('emission_processes').select('rtmp').eq('id', 13).maybeSingle();
                    targetRtmp = rowTel?.rtmp || 'hls-local';
                  }
                  await fetch(`http://localhost:${PORT}/api/emit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      source_m3u8: TELETICA_OFFICIAL_URL,
                      target_rtmp: targetRtmp,
                      process_id: '13',
                      is_recovery: true,
                    }),
                  });
                } catch (e) {
                  sendLog('13', 'error', `❌ Reintento OFICIAL falló: ${e.message}`);
                }
                return; // No continuar al autoRecoverChannel (scraping) este ciclo.
              }
              // 2 reintentos agotados → flip a scraping y continuar con recovery normal.
              setTeleticaSourceMode('13', 'scraping');
              teleticaOfficialFailures.set('13', 0);
              sendLog('13', 'warn', `⚠️ Fuente OFICIAL Teletica falló ${TELETICA_OFFICIAL_MAX_RETRIES}+1 veces consecutivas — cambiando AUTOMÁTICAMENTE a modo SCRAPING para recovery`);
            }
            await autoRecoverChannel(process_id, channelId, channelName);
          });
        } else if (process_id === '26') {
          // FOX+ ALTERNO: re-scrape con player_url guardado (mismo patrón que FUTV ALTERNO/17).
          sendLog('26', 'warn', `🔄 FOX+ ALTERNO caído (código ${code}) - Iniciando recovery con player_url guardado...`);
          enqueueRecovery('26', async () => {
            await sleep(500);
            if (manualStopProcesses.has('26') || manualStopProcesses.has(26)) {
              sendLog('26', 'info', `🛑 Recovery cancelado: parada manual detectada durante espera`);
              return;
            }
            try {
              const { data: row26 } = await supabase
                .from('emission_processes').select('player_url').eq('id', 26).maybeSingle();
              const playerUrl = row26?.player_url;
              const m = playerUrl ? (String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i)) : null;
              const channelId = m ? m[1] : null;
              if (!channelId) {
                sendLog('26', 'error', `❌ Recovery 26: player_url inválida o ausente, no se puede re-scrapear`);
                return;
              }
              await autoRecoverChannel('26', channelId, 'FOX+ ALTERNO');
            } catch (e) {
              sendLog('26', 'error', `❌ Recovery FOX+ ALTERNO falló: ${e.message}`);
            }
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
      lastFrameTime.delete(process_id); lastFrameNumber.delete(process_id);
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
    const { target_rtmp, process_id = '3', output_profile = null } = req.body;
    const files = req.files;
    const outputProfileKey = saveOutputProfileForProcess(process_id, output_profile || getStoredOutputProfile(process_id));
    const outputProfile = getOutputProfileConfig(outputProfileKey);

    sendLog(process_id, 'info', `Nueva solicitud de emisión con archivos`, { 
      fileCount: files?.length || 0, 
      target_rtmp,
      output_profile: outputProfileKey,
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
      // >5000kbps o no detectado: re-encodear con perfil seleccionado
      sendLog(process_id, 'info', `📺 Subida: ${srcBitrate || '?'}kbps > 5000 → Re-encode ${outputProfile.label} CBR ${outputProfile.videoBitrate} ${outputProfile.width}p30`);
      videoParams = [
        '-c:v', 'libx264', '-preset', outputProfile.preset || 'veryfast', '-profile:v', 'main',
        '-threads', '4',
        '-b:v', outputProfile.videoBitrate, '-maxrate', outputProfile.videoBitrate, '-bufsize', outputProfile.bufsize,
        ...(outputProfile.x264Params ? ['-x264-params', outputProfile.x264Params] : []),
        '-vf', `scale=-2:${outputProfile.width}`,
        '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'
      ];
      audioParams = ['-c:a', 'aac', '-b:a', outputProfile.audioBitrate, '-ar', '44100'];
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
    // Los canales en CHANNELS_VIA_PI_WG (11 en modo Telecable, 15/24/25 en TDMax)
    // se lanzan con `-http_proxy` apuntando al tinyproxy del Pi5 → IP residencial CR.
    const [spawnCmd, spawnArgs] = wrapFfmpegSpawn(process_id, ffmpegArgs);
    if (isViaCrTunnel(process_id)) {
      sendLog(process_id, 'info', `🇨🇷 Saliendo vía túnel WireGuard CR (Pi5) — http_proxy ${LOCAL_PROXY_URL}`);
    }
    const ffmpegProcess = spawn(spawnCmd, spawnArgs, {
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
        updateLiveStats(process_id, output);
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
          healthRecordFrame(process_id, parseInt(frameMatch[1], 10));
          if (now - lastLog >= PROGRESS_LOG_INTERVAL) {
            lastProgressLog.set(process_id, now);
            sendLog(process_id, 'info', healthFormatProgress(process_id, frameMatch[1], fpsMatch[1], null));
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
    markProcessManuallyStopped(process_id);


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
      // Cerrar listener srt-live-transmit persistente (solo en parada manual)
      if (isSrtIngestProcess(process_id)) stopSrtListener(process_id);
      // Apagar FILLER FOX/FOX+ si estuviera corriendo (sólo parada manual)
      if (foxIsFillerSupported(process_id) && foxIsFillerActive(process_id)) {
        await foxStopFillerAndWait(process_id, sendLog);
      }

      // Limpiar el HLS slug para que clientes (XUI/Odin) reciban 404 y
      // caigan a su URL de backup en vez de quedarse pegados al último
      // segmento. Guard interno respeta slugs compartidos.
      clearHlsSlugForPid(process_id, internal_refresh ? 'refresh' : 'stop manual');

      detectedErrors.delete(process_id);
      quickRetryState.delete(process_id);
      lastFrameTime.delete(process_id); lastFrameNumber.delete(process_id);
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
      // IMPORTANTE: la parada manual ya quedó marcada arriba para cancelar
      // cualquier recovery programado (setTimeout pendiente).
      // Apagar FILLER FOX/FOX+ si quedó huérfano sin LIVE
      if (foxIsFillerSupported(process_id) && foxIsFillerActive(process_id)) {
        await foxStopFillerAndWait(process_id, sendLog);
      }

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
// ── Endpoint /api/emit/drop ──────────────────────────────────────────
// TEST manual: mata el FFmpeg LIVE de FOX URL (25) o FOX+ URL (24)
// SIN marcar como parada manual. El close-handler dispara entonces el
// filler "RECONECTANDO" y el auto-recovery (re-scrape TDMax). Permite
// validar visualmente el ciclo: caída → filler → nueva señal.
app.post('/api/emit/drop', async (req, res) => {
  try {
    const { process_id: rawProcessId } = req.body || {};
    const process_id = String(rawProcessId);
    const ALLOWED = new Set(['24', '25']);
    if (!ALLOWED.has(process_id)) {
      return res.status(400).json({ error: 'Drop solo permitido para FOX URL (25) y FOX+ URL (24)' });
    }

    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (!processData || !processData.process || processData.process.killed) {
      return res.status(409).json({ error: 'No hay FFmpeg activo para este proceso' });
    }

    // CLAVE: NO añadir a manualStopProcesses → el close-handler tratará
    // esto como caída real y disparará filler + autoRecoverChannel.
    sendLog(process_id, 'warn', '💣 BOTAR (test): matando FFmpeg para simular caída — filler debería activarse');

    try { processData.process.kill('SIGKILL'); } catch (e) {
      return res.status(500).json({ error: `No se pudo matar FFmpeg: ${e.message}` });
    }
    if (processData.process.pid) {
      try { execSync(`kill -9 ${processData.process.pid}`, { stdio: 'ignore' }); } catch (_) {}
    }

    return res.json({ ok: true, message: 'FFmpeg matado. Filler + auto-recovery deberían activarse.' });
  } catch (error) {
    console.error('Error en /api/emit/drop:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Reinicio MANUAL en caliente: detiene FFmpeg actual, invalida la cache de
// sesión de scraping (cookies/token) para forzar un re-login completo, y
// vuelve a arrancar la emisión. El nuevo arranque elige automáticamente un
// User-Agent rotativo distinto (ver pickRandomUserAgent en /api/emit), lo
// que equivale a "abrir una sesión fresca como cliente nuevo".
// ESTE FLUJO ES INDEPENDIENTE DEL "Encendido siempre": no toca always_on.
app.post('/api/emit/restart', async (req, res) => {
  try {
    const { process_id: rawProcessId = '0', source_m3u8, target_rtmp, output_profile = null } = req.body;
    const process_id = String(rawProcessId);
    const numericProcessId = parseInt(process_id, 10);

    if (isNaN(numericProcessId) || numericProcessId < 0 || numericProcessId > 30) {
      return res.status(400).json({ error: `ID inválido: ${rawProcessId}` });
    }
    const outputProfileKey = saveOutputProfileForProcess(process_id, output_profile || getStoredOutputProfile(process_id));

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
      lastFrameTime.delete(process_id); lastFrameNumber.delete(process_id);
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
    manualStopProcesses.delete(String(process_id));
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

    // 5a) Si es un canal scrapeado (TDMax), la URL guardada lleva un token
    //     wmsAuthSign con validez de 1 minuto. Reusarla siempre cuelga al
    //     FFmpeg (no recibe primer frame). Forzar scraping fresco vía
    //     autoRecoverChannel para obtener token nuevo.
    const isTeleticaOfficialMode = process_id === '13' && (teleticaSourceMode.get(process_id) === 'official');
    if (CHANNEL_MAP[process_id] && !isTeleticaOfficialMode) {
      const { channelId, channelName } = CHANNEL_MAP[process_id];
      sendLog(process_id, 'info', `🔄 Reinicio: forzando scraping fresco (token TDMax expira en 60s)`);
      autoRecoveryInProgress.delete(process_id);
      recoveryAttempts.set(process_id, 0);
      autoRecoverChannel(process_id, channelId, channelName).catch(e => {
        sendLog(process_id, 'error', `❌ Reinicio (scraping fresco) falló: ${e.message}`);
      });
      sendLog(process_id, 'success', `✅ Reinicio en caliente disparado (scraping fresco en curso)`);
      return res.json({ success: true, message: 'Reinicio con scraping fresco en curso' });
    }

    // 5b) FUTV ALTERNO (17) / FOX+ ALTERNO (26): re-scrape con player_url guardada.
    if ((process_id === '17' || process_id === '26') && supabase) {
      const { data: rowAlt } = await supabase
        .from('emission_processes')
        .select('player_url')
        .eq('id', numericProcessId)
        .maybeSingle();
      const playerUrl = rowAlt?.player_url;
      const channelName = process_id === '17' ? 'FUTV ALTERNO' : 'FOX+ ALTERNO';
      const m = playerUrl ? (String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i)) : null;
      const channelId = m ? m[1] : null;
      if (!channelId) {
        sendLog(process_id, 'error', `❌ Reinicio ${channelName}: no hay player_url guardada válida`);
        return res.status(400).json({ error: 'Sin player_url guardada para reiniciar' });
      }
      autoRecoveryInProgress.delete(process_id);
      recoveryAttempts.set(process_id, 0);
      sendLog(process_id, 'info', `🔄 Reinicio: re-scrapeando ${channelName} con player_url guardada`);
      autoRecoverChannel(process_id, channelId, channelName).catch(e => {
        sendLog(process_id, 'error', `❌ Reinicio (re-scrape) falló: ${e.message}`);
      });
      sendLog(process_id, 'success', `✅ Reinicio en caliente disparado (re-scrape en curso)`);
      return res.json({ success: true, message: 'Reinicio con re-scrape en curso' });
    }

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
        output_profile: outputProfileKey,
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
    markProcessManuallyStopped(process_id);
    
    // Primero detener el proceso si está corriendo
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (processData && processData.process && !processData.process.killed) {
      const procRef = processData.process;
      procRef.kill('SIGKILL');
      await waitForProcessDeath(procRef, 2000);
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



app.get('/api/teletica/source-mode', (req, res) => {
  res.json({ mode: getTeleticaSourceMode('13') });
});

app.get('/api/canal6/source-mode', (req, res) => {
  res.json({ mode: getCanal6SourceMode('15') });
});

// ───── TELECABLE — endpoints genéricos por pid ─────
// Funciona para cualquier pid en TELECABLE_PROCESSES (FUTV/Teletica/TDMas1/Canal6/FOX+/FOX).
const telecableSourceModePayload = (pid) => {
  const st = telecableState.get(String(pid));
  const baseMode = getTelecableSourceMode(pid);
  const profile = getTelecableProfile(pid);
  // El frontend distingue 'telecable' (perfil minimal) de 'telecable_vlc'
  // (perfil Disney 7). Exponemos la variante como `mode` para que el toggle
  // de FOX+ (24) refleje bien el estado en curso.
  const reportedMode = baseMode === 'telecable' && profile === 'disney7' ? 'telecable_vlc' : baseMode;
  return {
    mode: reportedMode,
    profile,
    telecable: st
      ? {
          content_id: st.contentId,
          quality: st.quality,
          fetched_at: st.fetchedAt,
          expires_at: st.expiresAt,
          expires_in_s: st.expiresAt ? Math.max(0, st.expiresAt - Math.floor(Date.now() / 1000)) : null,
        }
      : null,
    last_login_failure_count: telecableFailureCount.get(String(pid)) || 0,
  };
};

app.get('/api/telecable/:pid/source-mode', (req, res) => {
  const pid = String(req.params.pid);
  if (!TELECABLE_PROCESSES.has(pid)) return res.status(404).json({ error: `pid ${pid} no soporta Telecable` });
  res.json(telecableSourceModePayload(pid));
});

app.post('/api/telecable/:pid/source-mode', (req, res) => {
  const pid = String(req.params.pid);
  if (!TELECABLE_PROCESSES.has(pid)) return res.status(404).json({ error: `pid ${pid} no soporta Telecable` });
  const requested = req.body?.mode;
  if (requested !== 'telecable' && requested !== 'scraping' && requested !== 'telecable_vlc') {
    return res.status(400).json({ error: 'Modo inválido (telecable|telecable_vlc|scraping)' });
  }
  const mode = setTelecableSourceMode(pid, requested);
  res.json({ ok: true, mode, profile: getTelecableProfile(pid) });
});

app.post('/api/telecable/:pid/refresh', async (req, res) => {
  const pid = String(req.params.pid);
  if (!TELECABLE_PROCESSES.has(pid)) return res.status(404).json({ error: `pid ${pid} no soporta Telecable` });
  try {
    // Preservar la variante (telecable vs telecable_vlc) — si el usuario está
    // en VLC LIKE y toca refresh, NO queremos degradar el profile a 'default'.
    const currentProfile = getTelecableProfile(pid);
    const preservedMode = currentProfile === 'disney7' ? 'telecable_vlc' : 'telecable';
    setTelecableSourceMode(pid, preservedMode);
    const overrideCid = req.body?.content_id ? String(req.body.content_id) : null;
    if (overrideCid) {
      const prev = telecableState.get(pid);
      if (!prev || prev.contentId !== overrideCid) {
        telecableState.set(pid, { ...(prev || {}), contentId: overrideCid });
      }
      persistTelecableField(pid, 'contentId', overrideCid);
    }
    // Calidad fija en TELECABLE_DEFAULT_QUALITY (40 = máxima real que entrega Telecable hoy).
    const st = await safeTelecableResolve(pid, overrideCid, null);
    res.json({
      ok: true,
      url: st.url,
      content_id: st.contentId,
      expires_at: st.expiresAt,
      expires_in_s: st.expiresAt ? Math.max(0, st.expiresAt - Math.floor(Date.now() / 1000)) : null,
      quality: st.quality,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Discovery: lista TODOS los canales que devuelve la playlist Telecable.
// Útil para ajustar TELECABLE_CHANNEL_MATCHERS si los content-id reales no matchean.
app.get('/api/telecable/channels', async (req, res) => {
  try {
    // Si tenemos caché reciente (<5 min) y no se pide force, devolvemos esa.
    const cacheAge = Math.floor(Date.now() / 1000) - lastTelecablePlaylist.fetchedAt;
    if (!req.query.force && lastTelecablePlaylist.channels.length > 0 && cacheAge < 300) {
      return res.json({ ok: true, cached: true, age_s: cacheAge, channels: lastTelecablePlaylist.channels });
    }
    // Forzar un resolve con cualquier pid existente (usa el primero del set).
    const anyPid = [...TELECABLE_PROCESSES][0];
    await telecableLoginAndResolve(anyPid).catch(() => {}); // ignoramos error de "channel not found"
    res.json({ ok: true, cached: false, age_s: 0, channels: lastTelecablePlaylist.channels });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── ALIASES legacy (FOX URL pid 25) ── mantenidos para no romper clientes viejos.
app.get('/api/fox/source-mode', (req, res) => res.json(telecableSourceModePayload('25')));

app.post('/api/fox/source-mode', (req, res) => {
  const requested = req.body?.mode;
  if (requested !== 'telecable' && requested !== 'scraping') {
    return res.status(400).json({ error: 'Modo FOX inválido' });
  }
  res.json({ ok: true, mode: setTelecableSourceMode('25', requested) });
});
app.post('/api/fox/refresh-telecable', async (req, res) => {
  try {
    setTelecableSourceMode('25', 'telecable');
    const st = await safeTelecableResolve('25');
    res.json({
      ok: true, url: st.url, expires_at: st.expiresAt,
      expires_in_s: st.expiresAt ? Math.max(0, st.expiresAt - Math.floor(Date.now() / 1000)) : null,
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ============= CR TUNNEL HEALTH =============
// Devuelve si el túnel WireGuard al Pi5 está vivo y la IP pública que ve el
// usuario `croute` (debe ser CR). Cachea resultado 10s para no martillar
// api.ipify.org desde el dashboard.
const crTunnelHealthState = { wg_up: false, cr_ip: null, last_check: 0, checking: false };
const refreshCrTunnelHealth = async () => {
  if (crTunnelHealthState.checking) return crTunnelHealthState;
  const now = Date.now();
  if (now - crTunnelHealthState.last_check < 10000) return crTunnelHealthState;
  crTunnelHealthState.checking = true;
  try {
    // 1) ¿wg0 levantado y con peer?
    let wgUp = false;
    try {
      const out = execSync('wg show wg0 latest-handshakes 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
      // Línea: "<pubkey>\t<unix_ts>". Handshake reciente (<180s) = peer vivo.
      const ts = parseInt((out.trim().split(/\s+/)[1] || '0'), 10);
      wgUp = ts > 0 && (Math.floor(Date.now() / 1000) - ts) < 180;
    } catch { wgUp = false; }

    // 2) IP pública vista por croute (si está wg_up).
    let crIp = null;
    if (wgUp) {
      try {
        const ip = execSync(
          `sudo -n -u ${CR_TUNNEL_USER} curl -fsS --max-time 5 https://api.ipify.org`,
          { encoding: 'utf8', timeout: 7000 }
        ).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) crIp = ip;
      } catch (_) { /* keep null */ }
    }

    crTunnelHealthState.wg_up = wgUp;
    crTunnelHealthState.cr_ip = crIp;
    crTunnelHealthState.last_check = now;
  } finally {
    crTunnelHealthState.checking = false;
  }
  return crTunnelHealthState;
};

app.get('/api/cr-tunnel/health', async (req, res) => {
  try {
    const h = await refreshCrTunnelHealth();
    res.json({
      wg_up: h.wg_up,
      cr_ip: h.cr_ip,
      last_check: h.last_check,
      channels: Array.from(CHANNELS_VIA_PI_WG).map(Number),
    });
  } catch (err) {
    res.status(500).json({ wg_up: false, cr_ip: null, error: err.message });
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
      live: getLiveStats(process_id),
      timestamp: new Date().toISOString()
    });
  } else {
    // Cuando no se pide un process_id, también devolvemos el modo Teletica
    // (usado por el frontend para sincronizar el toggle tras un fallback automático).
    // Estado de todos los procesos
    const allStatuses = {};
    for (let i = 0; i <= 26; i++) {
      const id = i.toString();
      const processData = ffmpegProcesses.get(id) ?? ffmpegProcesses.get(String(id));
      allStatuses[id] = {
        status: emissionStatuses.get(id) || 'idle',
        process_running: processData && processData.process && !processData.process.killed,
        live: getLiveStats(id)
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
    build: APP_BUILD_MARKER,
    tdmax_lb_params: TDMAX_LB_PARAM_MODE,
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
        // Convertir bytes/s → megabits/s (Mbps reales, lo que usan los proveedores)
        // bytes * 8 = bits; / 1_000_000 = Mbps (base 10, no Mebibits)
        const rxRate = elapsed > 0 ? ((current.rx - prevNetStats.rx) * 8 / elapsed / 1_000_000) : 0;
        const txRate = elapsed > 0 ? ((current.tx - prevNetStats.tx) * 8 / elapsed / 1_000_000) : 0;
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

// Velocidad nominal del NIC físico (Mbps). Lee /sys/class/net/<iface>/speed.
// Se cachea: el link speed no cambia en runtime.
let cachedLinkMbps = null;
const getNicLinkMbps = () => {
  if (cachedLinkMbps !== null) return cachedLinkMbps;
  try {
    const base = '/sys/class/net';
    if (!fs.existsSync(base)) { cachedLinkMbps = 0; return 0; }
    const ifaces = fs.readdirSync(base).filter(n => n !== 'lo' && !n.startsWith('docker') && !n.startsWith('veth') && !n.startsWith('br-'));
    let best = 0;
    for (const name of ifaces) {
      try {
        const speedFile = `${base}/${name}/speed`;
        if (!fs.existsSync(speedFile)) continue;
        const v = parseInt(fs.readFileSync(speedFile, 'utf8').trim(), 10);
        if (Number.isFinite(v) && v > best) best = v;
      } catch {}
    }
    cachedLinkMbps = best > 0 ? best : 0;
    return cachedLinkMbps;
  } catch {
    cachedLinkMbps = 0;
    return 0;
  }
};

// Uso de disco del volumen raíz (donde viven HLS/logs)
const getDiskStats = () => {
  try {
    if (typeof fs.statfsSync !== 'function') return { totalGB: 0, usedGB: 0, freeGB: 0, percent: 0 };
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    return {
      totalGB: Math.round(total / 1024 / 1024 / 1024 * 10) / 10,
      usedGB: Math.round(used / 1024 / 1024 / 1024 * 10) / 10,
      freeGB: Math.round(free / 1024 / 1024 / 1024 * 10) / 10,
      percent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch {
    return { totalGB: 0, usedGB: 0, freeGB: 0, percent: 0 };
  }
};

// Swap desde /proc/meminfo (alerta temprana: si empieza a usarse, RAM saturada)
const getSwapStats = () => {
  try {
    if (!fs.existsSync('/proc/meminfo')) return { totalMB: 0, usedMB: 0, percent: 0 };
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const tot = parseInt((txt.match(/SwapTotal:\s+(\d+)/) || [])[1] || '0', 10); // kB
    const free = parseInt((txt.match(/SwapFree:\s+(\d+)/) || [])[1] || '0', 10);
    const used = Math.max(0, tot - free);
    return {
      totalMB: Math.round(tot / 1024),
      usedMB: Math.round(used / 1024),
      percent: tot > 0 ? Math.round((used / tot) * 1000) / 10 : 0,
    };
  } catch {
    return { totalMB: 0, usedMB: 0, percent: 0 };
  }
};

// Cuenta procesos FFmpeg activos en el sistema (escaneo barato de /proc)
const getFfmpegCount = () => {
  try {
    if (!fs.existsSync('/proc')) return 0;
    const entries = fs.readdirSync('/proc');
    let n = 0;
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      try {
        const comm = fs.readFileSync(`/proc/${e}/comm`, 'utf8').trim();
        if (comm === 'ffmpeg') n++;
      } catch {}
    }
    return n;
  } catch {
    return 0;
  }
};

app.get('/api/metrics', (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    const cpuUsage = getCpuUsage();
    const network = getNetworkStats();
    const linkMbps = getNicLinkMbps();
    const disk = getDiskStats();
    const swap = getSwapStats();
    const ffmpegCount = getFfmpegCount();
    const cores = os.cpus().length;
    const load = os.loadavg();
    
    res.json({
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        cores,
        loadRatio: cores > 0 ? Math.round((load[0] / cores) * 100) / 100 : 0, // >1 = saturado
      },
      memory: {
        total: Math.round(totalMem / 1024 / 1024), // MB
        used: Math.round(usedMem / 1024 / 1024),
        free: Math.round(freeMem / 1024 / 1024),
        percent: Math.round((usedMem / totalMem) * 1000) / 10
      },
      network: {
        rxMbps: network.rxMbps,
        txMbps: network.txMbps,
        linkMbps,
        rxPercent: linkMbps > 0 ? Math.round((network.rxMbps / linkMbps) * 1000) / 10 : 0,
        txPercent: linkMbps > 0 ? Math.round((network.txMbps / linkMbps) * 1000) / 10 : 0,
      },
      disk,
      swap,
      ffmpegCount,
      uptime: os.uptime(),
      loadAvg: load,
    });
  } catch (error) {
    // Nunca devolver 500 al dashboard de métricas
    res.status(200).json({
      timestamp: Date.now(),
      cpu: { usage: 0, cores: 0, loadRatio: 0 },
      memory: { total: 0, used: 0, free: 0, percent: 0 },
      network: { rxMbps: 0, txMbps: 0, linkMbps: 0, rxPercent: 0, txPercent: 0 },
      disk: { totalGB: 0, usedGB: 0, freeGB: 0, percent: 0 },
      swap: { totalMB: 0, usedMB: 0, percent: 0 },
      ffmpegCount: 0,
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
  '16': 'DISNEY 7 SRT', '17': 'FUTV ALTERNO', '18': 'FUTV SRT', '19': 'RANDOM Disney 7', '20': 'CANAL 6 SRT', '21': 'TELETICA SRT', '22': 'FOX+ SRT', '23': 'FOX SRT', '24': 'FOX+ URL', '25': 'FOX URL', '26': 'FOX+ ALTERNO', '27': 'Canal 8 URL', '28': 'Canal 2 URL',
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
    // Nota: TIGO SRT (12), DISNEY 7 SRT (16) y FUTV SRT (18) SÍ admiten "Encendido siempre".
    // El listener SRT ya se auto-arranca al boot; activar always_on permite que, si el
    // proceso cae en caliente, el watchdog/recovery lo vuelva a levantar sin intervención.
    // Quedan excluidos del refresh horario 00:00/05:00 (no tienen URL que refrescar).
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

    // FOX+ ALTERNO (26): solo permitir always_on si tiene player_url guardada
    if (String(process_id) === '26' && enabled) {
      const { data: row26 } = await supabase
        .from('emission_processes')
        .select('player_url')
        .eq('id', 26)
        .maybeSingle();
      if (!row26?.player_url) {
        return res.status(400).json({
          error: 'FOX+ ALTERNO requiere extraer una URL del player TDMax antes de activar "Encendido siempre".',
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
        for (let id = 0; id <= 26; id++) {
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
    for (const id of [12, 16, 18, 20]) {
      supabase
        .from('emission_processes')
        .update({ m3u8: 'srt://obs', rtmp: 'hls-local' })
        .eq('id', id)
        .then(({ error }) => {
          if (error) console.error(`Error fijando preset SRT (id=${id}) al iniciar servidor:`, error.message);
        });
    }

    // ====== Cargar modo Teletica URL (13) desde DB para sobrevivir reinicios ======
    (async () => {
      try {
        const { data: row } = await supabase
          .from('emission_processes')
          .select('source_mode')
          .eq('id', 13)
          .maybeSingle();
        const persisted = row?.source_mode === 'official' ? 'official' : 'scraping';
        teleticaSourceMode.set('13', persisted);
        sendLog('13', 'info', `🎛️ Modo Teletica restaurado desde DB: ${persisted.toUpperCase()}`);
      } catch (err) {
        console.error('Error cargando teletica source_mode desde DB:', err.message);
      }
    })();

    // ====== Cargar modo Canal 6 URL (15) desde DB ======
    (async () => {
      try {
        const { data: row } = await supabase
          .from('emission_processes')
          .select('source_mode')
          .eq('id', 15)
          .maybeSingle();
        const persisted = row?.source_mode === 'official' ? 'official' : 'scraping';
        canal6SourceMode.set('15', persisted);
        sendLog('15', 'info', `🎛️ Modo Canal 6 restaurado desde DB: ${persisted.toUpperCase()}`);
      } catch (err) {
        console.error('Error cargando canal6 source_mode desde DB:', err.message);
      }
    })();

    // ====== Cargar modo Telecable (todos los TELECABLE_PROCESSES) desde DB ======
    // Restaura 'telecable' o 'telecable_vlc' (Telecable + perfil Disney 7 forzado)
    // para que un reinicio del server preserve la elección del usuario. Sin esto,
    // los canales always_on volvían a 'scraping' por default tras un restart.
    (async () => {
      try {
        const pids = Array.from(TELECABLE_PROCESSES).map(p => parseInt(p, 10)).filter(n => !Number.isNaN(n));
        if (pids.length === 0) return;
        const { data: rows } = await supabase
          .from('emission_processes')
          .select('id, source_mode')
          .in('id', pids);
        for (const row of rows || []) {
          const pid = String(row.id);
          const mode = row.source_mode;
          if (mode === 'telecable_vlc' || mode === 'telecable') {
            // setTelecableSourceMode ajusta profile ('disney7' vs 'default')
            // pero re-persiste en DB — pasamos por los Maps directamente para
            // evitar el UPDATE redundante al arrancar.
            telecableSourceMode.set(pid, 'telecable');
            setTelecableProfile(pid, mode === 'telecable_vlc' ? 'disney7' : 'default');
            const label = mode === 'telecable_vlc' ? 'TELECABLE + VLC LIKE (Disney7)' : 'TELECABLE';
            sendLog(pid, 'info', `🎛️ Modo restaurado desde DB: ${label}`);
          }
        }
      } catch (err) {
        console.error('Error cargando telecable source_mode desde DB:', err.message);
      }
    })();

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
          // TIGO SRT (12), DISNEY 7 SRT (16) y FUTV SRT (18) se autoarrancan por su propio path (OBS local).
          // FUTV ALTERNO (17) sí se relanza si tiene player_url guardada (re-scrape fresco).
          // TELETICA SRT (21), FOX+ SRT (22) y FOX SRT (23) son SRT-ingest desde Pi5: se relanzan abajo.
          if (pid === '12' || pid === '16' || pid === '18') continue;

          // Si el usuario ya arrancó manualmente este canal mientras esperábamos
          // los 8s de gracia, NO disparar el relaunch: mataría el FFmpeg recién
          // nacido y haría un scrape redundante. Solo continuar si NO hay
          // proceso vivo para este pid.
          if (ffmpegProcesses.has(pid) || ffmpegProcesses.has(Number(pid))) {
            sendLog(pid, 'info', `⏭️ Always-on omitido: ya hay emisión activa iniciada manualmente`);
            continue;
          }

          // Limpiar manualStop por si quedó marcado
          manualStopProcesses.delete(pid);
          manualStopProcesses.delete(Number(pid));

          try {
            if (PI_SRT_INGEST_PROCESSES.has(pid)) {
              // SRT-ingest desde Raspberry Pi5: abrir listener SRT + ETAPA 2.
              const cfg = SRT_INGEST_CONFIGS[pid];
              sendLog(pid, 'info', `🔁 Always-on: relanzando ${cfg?.label || `SRT ${pid}`} (listener desde Pi5)...`);
              await fetch(`http://localhost:${PORT}/api/emit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source_m3u8: 'srt://obs',
                  target_rtmp: 'hls-local',
                  process_id: pid,
                  is_recovery: true,
                }),
              });
            } else if (pid === '13' && getTeleticaSourceMode('13') === 'official') {
              // TELETICA URL en modo OFICIAL: relanzar con URL fija de Bradmax,
              // sin scraping TDMax. Respeta la selección del usuario tras reinicio.
              sendLog('13', 'info', `🔁 Always-on: relanzando Teletica URL en modo OFICIAL (Bradmax CDN)...`);
              await fetch(`http://localhost:${PORT}/api/emit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source_m3u8: TELETICA_OFFICIAL_URL,
                  target_rtmp: row.rtmp || 'rtmp://localhost:1935/live/Teletica',
                  process_id: '13',
                  is_recovery: true,
                }),
              });
            } else if (CHANNEL_MAP[pid]) {
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
            } else if (pid === '26') {
              // FOX+ ALTERNO: re-scrape con player_url persistido (mismo patrón que 17)
              const playerUrl = row.player_url;
              if (!playerUrl) {
                sendLog('26', 'warn', `⚠️ Always-on activo pero no hay player_url guardada (volver a extraer)`);
              } else {
                const m = String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i);
                const channelId = m ? m[1] : null;
                if (!channelId) {
                  sendLog('26', 'error', `❌ player_url inválida: ${playerUrl}`);
                } else {
                  sendLog('26', 'info', `🔁 Always-on: re-scrapeando FOX+ ALTERNO con player_url guardada...`);
                  await autoRecoverChannel('26', channelId, 'FOX+ ALTERNO');
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
          // SRT/OBS locales excluidos del refresh horario:
          //   12/16/18 = OBS local;  21/22/23 = SRT-ingest desde Pi5 (el Pi5 refresca su propio token TDMax).
          // FUTV ALTERNO (17) sí refresca si tiene player_url.
          if (pid === '12' || pid === '16' || pid === '18' || PI_SRT_INGEST_PROCESSES.has(pid)) continue;

          // Guard: si refrescamos hace <60 min, saltar (evita doble disparo en la misma ventana)
          const lastRefresh = row.last_refresh_at ? new Date(row.last_refresh_at).getTime() : 0;
          if (now - lastRefresh < REFRESH_GUARD_MS) continue;

          sendLog(pid, 'info', `⏰ Refresh programado (${String(crHour).padStart(2, '0')}:00 CR): apagando 3 min para que XUI/Odin caigan al backup, luego URL fresca...`);

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
            // Asegurar que el HLS quede vacío (el stop ya lo intenta, pero
            // re-confirmamos por si quedó algún segmento por race condition).
            await new Promise(r => setTimeout(r, 1500));
            clearHlsSlugForPid(pid, 'refresh 3AM');
            // Pausa de 3 min para que XUI/Odin detecten el 404 y conmuten
            // a su URL de backup. Durante este tiempo NO servimos HLS.
            sendLog(pid, 'info', `⏸️ Canal apagado, esperando 3 min antes de relanzar (backup activo en XUI/Odin)...`);
            await new Promise(r => setTimeout(r, 180_000));
            // Limpieza final justo antes de relanzar, por si algo escribió
            // en el directorio durante la pausa.
            clearHlsSlugForPid(pid, 'pre-relaunch');
            // Limpiar manualStop ya que es un refresh interno, no un stop del usuario
            manualStopProcesses.delete(pid);
            manualStopProcesses.delete(Number(pid));

            if (CHANNEL_MAP[pid]) {
              const { channelId, channelName } = CHANNEL_MAP[pid];
              // TELETICA URL (13) en modo OFICIAL: NO scrapear, relanzar con Bradmax.
              if (pid === '13' && getTeleticaSourceMode('13') === 'official') {
                sendLog('13', 'info', `🔄 Refresh 3:00 CR: Teletica en modo OFICIAL, relanzando con Bradmax CDN (sin scraping)...`);
                await fetch(`http://localhost:${PORT}/api/emit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: TELETICA_OFFICIAL_URL,
                    target_rtmp: row.rtmp || 'rtmp://localhost:1935/live/Teletica',
                    process_id: '13',
                    is_recovery: true,
                  }),
                });
              } else {
                await autoRecoverChannel(pid, channelId, channelName);
              }
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
            } else if (pid === '26') {
              const playerUrl = row.player_url;
              const m = playerUrl ? (String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i)) : null;
              const channelId = m ? m[1] : null;
              if (!channelId) {
                sendLog('26', 'error', `❌ Refresh 26: player_url inválida o ausente, omitiendo`);
              } else {
                sendLog('26', 'info', `🔄 Refresh 3:00 CR: re-scrapeando FOX+ ALTERNO con player_url guardada...`);
                await autoRecoverChannel('26', channelId, 'FOX+ ALTERNO');
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

  // ====== WATCHDOG ALWAYS-ON (IDs 15, 21, 22, 23, 24, 25, 26) ======
  // Si el switch "Encendido siempre" está activo y el proceso está caído (no emitiendo)
  // SIN parada manual ni descanso nocturno, lo relanzamos automáticamente.
  // Cubre el caso donde el recovery se rinde (cdn_unavailable / circuit_breaker) o el
  // listener SRT muere por un glitch y el proceso queda muerto hasta que alguien lo
  // levanta a mano.
  //
  //   • ID 15 (CANAL 6 URL): relanza con source_url + rtmp guardados en BD.
  //   • IDs 21/22/23 (TELETICA / FOX+ / FOX SRT desde Pi5): relanza listener SRT
  //     con payload fijo srt://obs + hls-local. Mientras always_on=true, el VPS
  //     siempre estará receptivo a la señal que el Pi5 envía 24/7.
  //   • IDs 24/25 (FOX+ URL / FOX URL): si TDMax estuvo intermitente y el
  //     autoRecoverChannel se rindió (sin fallback URL), aquí lo re-disparamos
  //     con scrape fresco para no quedar muerto hasta intervención manual.
  //   • ID 26 (FOX+ ALTERNO): mismo patrón usando player_url persistida.
  const ALWAYS_ON_WATCHDOG_IDS = ['15', '21', '22', '23', '24', '25', '26'];

  const tryRelaunchAlwaysOnChannel = async (PID) => {
    if (!supabase) return;
    const PID_NUM = Number(PID);

    // Respetar parada manual y descanso nocturno (1-5 AM)
    if (manualStopProcesses.has(PID) || manualStopProcesses.has(PID_NUM)) return;
    if (nightRestStoppedProcesses.has(PID)) return;
    const { hour: crHour } = getCostaRicaHour();
    if (crHour >= 1 && crHour < 5) return;

    // Si ya hay un FFmpeg vivo o un recovery en curso, no tocar
    const procData = ffmpegProcesses.get(PID) || ffmpegProcesses.get(PID_NUM);
    if (procData?.process && !procData.process.killed) return;
    if (autoRecoveryInProgress.get(PID)) return;

    const { data: row } = await supabase
      .from('emission_processes')
      .select('id, source_url, m3u8, rtmp, always_on, is_emitting, emit_status')
      .eq('id', PID_NUM)
      .single();

    if (!row || !row.always_on) return;
    if (row.is_emitting) return; // ya está emitiendo (o intentándolo)

    // Determinar payload según tipo de canal
    let payload;
    let label;
    if (isSrtIngestProcess(PID)) {
      const cfg = getSrtConfig(PID);
      label = cfg?.label || `SRT ${PID}`;
      payload = {
        source_m3u8: 'srt://obs',
        target_rtmp: 'hls-local',
        process_id: PID,
        is_recovery: true,
      };
    } else if (CHANNEL_MAP[PID]) {
      // Canales scrapeados (24/25 — y futuros): re-disparar scrape fresco vía
      // autoRecoverChannel. NO usar /api/emit con la URL vieja porque el
      // wmsAuthSign ya está expirado (es lo que rompió el ciclo original).
      const { channelId, channelName } = CHANNEL_MAP[PID];
      sendLog(PID, 'warn', `🔁 Watchdog always-on: ${channelName} caído con switch activo. Re-scrapeando URL fresca...`);
      try { failureTimestamps.delete(PID); } catch (_) {}
      recoveryAttempts.set(String(PID), 0);
      await supabase.from('emission_processes').update({
        emit_status: 'starting',
        is_emitting: true,
        is_active: true,
        failure_reason: null,
        failure_details: null,
      }).eq('id', PID_NUM);
      try {
        await autoRecoverChannel(String(PID), channelId, channelName);
      } catch (e) {
        sendLog(PID, 'error', `❌ Watchdog always-on: error en autoRecoverChannel: ${e.message}`);
      }
      return;
    } else if (String(PID) === '26') {
      // FOX+ ALTERNO: re-scrape con player_url persistida
      const playerUrl = row.player_url;
      if (!playerUrl) {
        sendLog('26', 'warn', `⚠️ Watchdog always-on: sin player_url guardada, no se puede relanzar`);
        return;
      }
      const m = String(playerUrl).match(/[?&]id=([a-f0-9]{24})/i) || String(playerUrl).match(/^([a-f0-9]{24})$/i);
      const channelId = m ? m[1] : null;
      if (!channelId) {
        sendLog('26', 'error', `❌ Watchdog always-on: player_url inválida: ${playerUrl}`);
        return;
      }
      sendLog('26', 'warn', `🔁 Watchdog always-on: FOX+ ALTERNO caído. Re-scrapeando con player_url...`);
      try { failureTimestamps.delete(PID); } catch (_) {}
      recoveryAttempts.set(String(PID), 0);
      await supabase.from('emission_processes').update({
        emit_status: 'starting',
        is_emitting: true,
        is_active: true,
        failure_reason: null,
        failure_details: null,
      }).eq('id', PID_NUM);
      try {
        await autoRecoverChannel('26', channelId, 'FOX+ ALTERNO');
      } catch (e) {
        sendLog('26', 'error', `❌ Watchdog always-on: error en autoRecoverChannel: ${e.message}`);
      }
      return;
    } else {
      // ID 15 (CANAL 6 URL) y similares: requieren URL guardada
      const sourceUrl = row.source_url || row.m3u8;
      const targetRtmp = row.rtmp;
      if (!sourceUrl || !targetRtmp) return;
      label = `CANAL ${PID}`;
      payload = {
        source_m3u8: sourceUrl,
        target_rtmp: targetRtmp,
        process_id: PID,
        is_recovery: true,
      };
    }

    sendLog(PID, 'warn', `🔁 Watchdog always-on: ${label} caído con switch activo. Relanzando automáticamente...`);

    // Limpiar fallos previos para que un circuit breaker viejo no nos bloquee
    try { failureTimestamps.delete(PID); } catch (_) {}

    await supabase.from('emission_processes').update({
      emit_status: 'starting',
      is_emitting: true,
      is_active: true,
      failure_reason: null,
      failure_details: null,
    }).eq('id', PID_NUM);

    try {
      await fetch(`http://localhost:${PORT}/api/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      sendLog(PID, 'error', `❌ Watchdog always-on: error al relanzar: ${e.message}`);
    }
  };

  setInterval(async () => {
    for (const pid of ALWAYS_ON_WATCHDOG_IDS) {
      try {
        await tryRelaunchAlwaysOnChannel(pid);
      } catch (err) {
        console.error(`Watchdog always-on (ID ${pid}) error:`, err);
      }
    }
  }, 2 * 60 * 1000); // cada 2 min

  // Auto-arranque TIGO SRT (ID 12) deshabilitado: tab oculto y canal descartado (HDCP).

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

// ───────────────────────────────────────────────────────────────────────
// Loop de refresh proactivo Telecable.
// Cada 60s revisa procesos en modo telecable: si la URL firmada vence en
// <TELECABLE_REFRESH_MARGIN_S, hace relogin silencioso para tener URL
// fresca lista para el próximo recovery. NO reinicia FFmpeg.
// ───────────────────────────────────────────────────────────────────────
setInterval(async () => {
  for (const pid of TELECABLE_PROCESSES) {
    if (!isTelecableMode(pid)) continue;
    // Solo refrescar si el proceso está realmente emitiendo en modo telecable.
    // Evita peticiones innecesarias a la API de Telecable cuando el estado
    // 'telecable' quedó persistido en DB pero el usuario está en otro modo
    // o el proceso está detenido.
    if (!ffmpegProcesses.has(String(pid))) continue;
    const st = telecableState.get(pid);
    const nowS = Math.floor(Date.now() / 1000);
    const secsLeft = st?.expiresAt ? (st.expiresAt - nowS) : 0;
    const needsRefresh = !st || !st.expiresAt || secsLeft < TELECABLE_REFRESH_MARGIN_S;
    if (!needsRefresh) continue;
    try {
      await safeTelecableResolve(pid);
      sendLog(pid, 'info', `🔁 Telecable URL refrescada proactivamente (preventivo)`);
    } catch (_) {
      // El error ya fue logueado por safeTelecableResolve. El próximo ciclo reintenta.
    }
  }
}, 60_000);
