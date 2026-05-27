#!/usr/bin/env node
/**
 * 🛰️  FOX SRT Pusher (Raspberry Pi 5 → VPS:9006)
 *
 *  Hace login en TDMax, obtiene la URL HLS LIVE de FOX con el
 *  IP del Pi5 (necesario para que el CDN no bloquee los segments)
 *  y la reenvía vía SRT en modo CALLER al puerto 9006 del VPS.
 *
 *  - Re-scrapea TDMax ÚNICAMENTE cuando ffmpeg muere (mismo enfoque que el VPS).
 *    No se tocan procesos sanos: si está emitiendo, sigue emitiendo.
 *  - Si FFmpeg muere por cualquier motivo, re-loguea y reintenta con backoff.
 *  - Si el VPS aún no abrió el SRT listener (el switch del panel está OFF),
 *    el SRT caller falla suave y el bucle vuelve a intentar — no se cae.
 *  - El dashboard manda; si el switch está OFF no habrá listener y
 *    el push queda en espera sin gastar ancho de banda del CDN.
 *
 *  Variables de entorno (definidas en /etc/fox-srt-pusher.env):
 *    VPS_HOST           IP/host público del VPS              (default 167.17.69.116)
 *    VPS_PORT           Puerto SRT en el VPS                 (default 9006)
 *    SRT_STREAMID       streamid SRT                         (default fox)
 *    SRT_LATENCY_US     Latencia SRT en microsegundos        (default 2000000)
 *    SRT_PASSPHRASE     Passphrase (opcional, debe coincidir con FOX_SRT_PASSPHRASE del VPS)
 *    TDMAX_EMAIL        Correo de la cuenta TDMax            (REQUERIDO)
 *    TDMAX_PASSWORD     Password de la cuenta TDMax          (REQUERIDO)
 *    LOG_VERBOSE        '1' para ver stderr crudo de ffmpeg  (default 0)
 */

'use strict';

const { spawn } = require('child_process');
const https = require('https');

const VPS_HOST       = process.env.VPS_HOST       || '167.17.69.116';
const VPS_PORT       = process.env.VPS_PORT       || '9006';
const SRT_STREAMID   = process.env.SRT_STREAMID   || 'fox';
const SRT_LATENCY_US = process.env.SRT_LATENCY_US || '2000000';
const SRT_PASSPHRASE = process.env.SRT_PASSPHRASE || '';
const TDMAX_EMAIL    = process.env.TDMAX_EMAIL    || '';
const TDMAX_PASSWORD = process.env.TDMAX_PASSWORD || '';
const LOG_VERBOSE    = process.env.LOG_VERBOSE === '1';

// Supabase (para comando manual "refresh" desde el dashboard)
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const PI_TARGET = 'fox';

// Estado informativo para detectar cambios de host/CDN entre reinicios reales.
let lastBaseHost   = '';

// Mismos valores que la edge function scrape-channel
const RESELLER_ID  = '61316705e4b0295f87dae396';
const BASE_URL     = 'https://cf.streann.tech';
const FOX_ID       = '664237788f085ac1f2a15f81';
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

async function getStreamHlsUrl() {
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
    `${BASE_URL}/loadbalancer/services/v1/channels-secure/${FOX_ID}/playlist.m3u8?${qs}`,
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

async function runOnce() {
  let hlsUrl;
  try {
    hlsUrl = await getStreamHlsUrl();
    log('🔑 URL FOX obtenida. ffmpeg corre indefinido; solo se re-scrapea si muere o por refresh manual.');
    backoffMs = 3000; // reset backoff tras login OK
    try {
      const newHost = new URL(hlsUrl).host;
      if (lastBaseHost && newHost !== lastBaseHost) {
        log(`🔄 TDMax rotó CDN: ${lastBaseHost} → ${newHost}`);
      }
      lastBaseHost = newHost;
    } catch {}
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

log(`🚀 FOX SRT pusher iniciado → ${VPS_HOST}:${VPS_PORT} (streamid=${SRT_STREAMID}, modo reactivo)`);
runOnce();


function supaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return reject(new Error('Supabase no configurado'));
    const u = new URL(SUPABASE_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 10_000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function pollCommands() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    const res = await supaRequest(
      'GET',
      `/rest/v1/pi5_commands?target=eq.${PI_TARGET}&consumed_at=is.null&order=created_at.asc&limit=1`,
    );
    if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) return;
    const cmd = res.body[0];
    log(`📥 Comando manual recibido: ${cmd.command} (id=${cmd.id})`);
    await supaRequest(
      'PATCH',
      `/rest/v1/pi5_commands?id=eq.${cmd.id}`,
      { consumed_at: new Date().toISOString(), consumed_by: PI_TARGET },
    );
    if (cmd.command === 'refresh') {
      if (currentProc) {
        log('🔄 Refresh manual — reiniciando ffmpeg + token TDMax');
        backoffMs = 3000;
        killCurrent('SIGTERM');
      } else {
        log('🔄 Refresh manual — ffmpeg no activo, reintento inmediato');
        backoffMs = 1000;
      }
    }
  } catch (e) {
    if (LOG_VERBOSE) warn(`pollCommands: ${e.message}`);
  }
}
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  const cmdTimer = setInterval(pollCommands, 15_000);
  if (cmdTimer.unref) cmdTimer.unref();
  log(`📡 Polling de comandos manuales activo (target=${PI_TARGET})`);
} else {
  warn('SUPABASE_URL / SUPABASE_ANON_KEY no definidos — el botón de Refresh manual no funcionará');
}