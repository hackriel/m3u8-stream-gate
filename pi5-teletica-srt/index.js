#!/usr/bin/env node
/**
 * 🛰️  Teletica SRT Pusher (Raspberry Pi 5 → VPS:9004)
 *
 *  Hace login en TDMax, obtiene la URL HLS LIVE de Teletica con el
 *  IP del Pi5 (necesario para que el CDN no bloquee los segments)
 *  y la reenvía vía SRT en modo CALLER al puerto 9004 del VPS.
 *
 *  - Re-scrapea TDMax ÚNICAMENTE cuando ffmpeg muere (mismo enfoque que el VPS).
 *    No se tocan procesos sanos: si está emitiendo, sigue emitiendo.
 *  - Si FFmpeg muere por cualquier motivo, re-loguea y reintenta con backoff.
 *  - Si el VPS aún no abrió el SRT listener (el switch del panel está OFF),
 *    el SRT caller falla suave y el bucle vuelve a intentar — no se cae.
 *  - El dashboard manda; si el switch está OFF no habrá listener y
 *    el push queda en espera sin gastar ancho de banda del CDN.
 *
 *  Variables de entorno (definidas en /etc/teletica-srt-pusher.env):
 *    VPS_HOST           IP/host público del VPS              (default 167.17.69.116)
 *    VPS_PORT           Puerto SRT en el VPS                 (default 9004)
 *    SRT_STREAMID       streamid SRT                         (default teletica)
 *    SRT_LATENCY_US     Latencia SRT en microsegundos        (default 2000000)
 *    SRT_PASSPHRASE     Passphrase (opcional, debe coincidir con TELETICA_SRT_PASSPHRASE del VPS)
 *    TDMAX_EMAIL        Correo de la cuenta TDMax            (REQUERIDO)
 *    TDMAX_PASSWORD     Password de la cuenta TDMax          (REQUERIDO)
 *    LOG_VERBOSE        '1' para ver stderr crudo de ffmpeg  (default 0)
 */

'use strict';

const { spawn } = require('child_process');
const https = require('https');

const VPS_HOST       = process.env.VPS_HOST       || '167.17.69.116';
const VPS_PORT       = process.env.VPS_PORT       || '9004';
const SRT_STREAMID   = process.env.SRT_STREAMID   || 'teletica';
const SRT_LATENCY_US = process.env.SRT_LATENCY_US || '2000000';
const SRT_PASSPHRASE = process.env.SRT_PASSPHRASE || '';
const TDMAX_EMAIL    = process.env.TDMAX_EMAIL    || '';
const TDMAX_PASSWORD = process.env.TDMAX_PASSWORD || '';
const LOG_VERBOSE    = process.env.LOG_VERBOSE === '1';

// Mismos valores que la edge function scrape-channel
const RESELLER_ID  = '61316705e4b0295f87dae396';
const BASE_URL     = 'https://cf.streann.tech';
const TELETICA_ID  = '617c2f66e4b045a692106126';
const DEVICE_ID    = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Origin': 'https://www.app.tdmax.com',
  'Referer': 'https://www.app.tdmax.com/',
  'x-app-name': 'TDMAX',
  'x-app-platform': 'web',
  'x-app-version': '3.1.1',
};

if (!TDMAX_EMAIL || !TDMAX_PASSWORD) {
  console.error('❌ Falta TDMAX_EMAIL / TDMAX_PASSWORD');
  process.exit(1);
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log  = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] ⚠️ `, ...a);
const err  = (...a) => console.error(`[${ts()}] ❌`, ...a);

function httpJson(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpHead(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 8192) res.destroy(); });
      res.on('end',  () => resolve({ status: res.statusCode, body: data }));
      res.on('close',() => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function getTeleticaUrl() {
  // 1) Login
  const loginBody = JSON.stringify({ username: TDMAX_EMAIL.toLowerCase(), password: TDMAX_PASSWORD });
  const loginRes = await httpJson(
    'POST',
    `${BASE_URL}/web/services/v3/external/login?r=${RESELLER_ID}`,
    { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
    loginBody,
  );
  const token = loginRes.body?.accessToken || loginRes.body?.access_token;
  if (!token) throw new Error(`Login fallido (status ${loginRes.status}): ${JSON.stringify(loginRes.body).slice(0,200)}`);

  // 2) Loadbalancer
  const qs = new URLSearchParams({
    r: RESELLER_ID,
    'device-id': DEVICE_ID,
    access_token: token,
    country_code: 'CR',
    doNotUseRedirect: 'true',
    'device-name': 'web',
    'device-type': 'web',
  });
  const lbRes = await httpJson(
    'GET',
    `${BASE_URL}/loadbalancer/services/v1/channels-secure/${TELETICA_ID}/playlist.m3u8?${qs}`,
    { ...BROWSER_HEADERS, Authorization: `Bearer ${token}` },
  );
  const streamUrl = lbRes.body?.url;
  if (!streamUrl) throw new Error(`LB sin URL (status ${lbRes.status}): ${JSON.stringify(lbRes.body).slice(0,200)}`);
  if (/cfvod\.streann\.tech|isVodPlaylist=true|unavailable|placeholder|slate/i.test(streamUrl)) {
    throw new Error(`TDMax devolvió placeholder/VOD: ${streamUrl.slice(0,160)}`);
  }

  // 3) Verificación rápida
  const verify = await httpHead(streamUrl, BROWSER_HEADERS);
  if (verify.status !== 200 || !verify.body.trimStart().startsWith('#EXTM3U') || /#EXT-X-ENDLIST/i.test(verify.body)) {
    throw new Error(`Playlist inválida (HTTP ${verify.status})`);
  }
  return streamUrl;
}

function buildSrtUrl() {
  const qs = new URLSearchParams({
    mode: 'caller',
    streamid: SRT_STREAMID,
    latency: SRT_LATENCY_US,
    pkt_size: '1316',
  });
  if (SRT_PASSPHRASE) {
    qs.set('pbkeylen', '16');
    qs.set('passphrase', SRT_PASSPHRASE);
  }
  return `srt://${VPS_HOST}:${VPS_PORT}?${qs.toString()}`;
}

function spawnFfmpeg(hlsUrl) {
  const srtUrl = buildSrtUrl();
  log(`▶️  ffmpeg: HLS → SRT ${srtUrl}`);

  const args = [
    '-hide_banner', '-loglevel', LOG_VERBOSE ? 'info' : 'warning',
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-user_agent', BROWSER_HEADERS['User-Agent'],
    '-headers', `Referer: ${BROWSER_HEADERS.Referer}\r\nOrigin: ${BROWSER_HEADERS.Origin}\r\n`,
    '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '4xx,5xx',
    '-reconnect_delay_max', '4',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '1000',
    '-re',
    '-i', hlsUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-bsf:v', 'h264_mp4toannexb',
    '-f', 'mpegts',
    '-flush_packets', '1',
    srtUrl,
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'pipe'] });
  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    if (LOG_VERBOSE) process.stderr.write(line);
    else {
      // Solo errores relevantes
      if (/error|fail|forbidden|denied|invalid|broken|Connection|HTTP 4|HTTP 5/i.test(line)) {
        process.stderr.write(line);
      }
    }
  });
  return proc;
}

let currentProc = null;
let stopRequested = false;
let backoffMs = 3000;

function killCurrent(signal = 'SIGTERM') {
  if (currentProc && !currentProc.killed) {
    try { currentProc.kill(signal); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────
// Refresh programado diario (00:00 y 05:00 hora Costa Rica, UTC-6 sin DST)
// Se calcula el próximo disparo exacto y se programa UN setTimeout.
// Tras ejecutarse (o al iniciar el servicio), se reprograma el siguiente.
// Nada de polling cada minuto.
// ─────────────────────────────────────────────────────────────
const REFRESH_HOURS_CR = [0, 5];
const CR_OFFSET_MS = 6 * 60 * 60 * 1000; // Costa Rica = UTC-6

function msUntilNextRefresh() {
  const nowUtcMs = Date.now();
  const crNow = new Date(nowUtcMs - CR_OFFSET_MS); // "reloj" CR en UTC fields
  let best = Infinity;
  let bestHh = -1;
  for (const hh of REFRESH_HOURS_CR) {
    // Próxima ocurrencia hoy en CR
    const candCr = new Date(Date.UTC(
      crNow.getUTCFullYear(), crNow.getUTCMonth(), crNow.getUTCDate(),
      hh, 0, 0, 0,
    ));
    let candUtcMs = candCr.getTime() + CR_OFFSET_MS;
    if (candUtcMs <= nowUtcMs) candUtcMs += 24 * 60 * 60 * 1000; // mañana
    const delta = candUtcMs - nowUtcMs;
    if (delta < best) { best = delta; bestHh = hh; }
  }
  return { ms: best, hh: bestHh };
}

let refreshTimer = null;
function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const { ms, hh } = msUntilNextRefresh();
  const mins = Math.round(ms / 60000);
  log(`⏰ Próximo refresh programado: ${hh.toString().padStart(2,'0')}:00 CR (en ~${mins} min)`);
  refreshTimer = setTimeout(() => {
    if (stopRequested) return;
    if (!currentProc) {
      log(`⏰ Refresh ${hh}:00 CR — ffmpeg no activo, se omite reciclaje`);
    } else {
      log(`⏰ Refresh ${hh}:00 CR — reciclando ffmpeg + token TDMax`);
      backoffMs = 3000;
      killCurrent('SIGTERM');
    }
    scheduleNextRefresh();
  }, ms);
  if (refreshTimer.unref) refreshTimer.unref();
}
scheduleNextRefresh();

async function runOnce() {
  let hlsUrl;
  try {
    hlsUrl = await getTeleticaUrl();
    log('🔑 URL Teletica obtenida. ffmpeg corre indefinido; solo se re-scrapea si muere.');
    backoffMs = 3000; // reset backoff tras login OK
  } catch (e) {
    err(`Scrape TDMax falló: ${e.message}`);
    return scheduleRetry();
  }

  currentProc = spawnFfmpeg(hlsUrl);

  currentProc.on('exit', (code, signal) => {
    currentProc = null;
    if (stopRequested) return;
    warn(`ffmpeg exit code=${code} signal=${signal} — reintentando en ${Math.round(backoffMs/1000)}s`);
    setTimeout(runOnce, backoffMs);
    backoffMs = Math.min(backoffMs * 1.5, 30000);
  });
}

function scheduleRetry() {
  warn(`Reintentando en ${Math.round(backoffMs/1000)}s`);
  setTimeout(runOnce, backoffMs);
  backoffMs = Math.min(backoffMs * 1.5, 30000);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`📴 ${sig} recibido — apagando…`);
    stopRequested = true;
    killCurrent('SIGTERM');
    setTimeout(() => process.exit(0), 1500);
  });
}

process.on('uncaughtException', (e) => { err('uncaughtException:', e?.stack || e?.message || e); });
process.on('unhandledRejection', (e) => { err('unhandledRejection:', e?.stack || e?.message || e); });

log(`🚀 Teletica SRT pusher iniciado → ${VPS_HOST}:${VPS_PORT} (streamid=${SRT_STREAMID}, modo reactivo)`);
runOnce();