#!/usr/bin/env node
/**
 * 🛰️  FOX SRT Pusher robusto (Raspberry Pi 5 → VPS:9006)
 *
 * Arquitectura 2026 para estabilidad:
 *   TDMax HLS → FFmpeg Stage A → UDP local:10006 → srt-live-transmit Stage B → VPS:9006
 *
 * - Una sola sesión TDMax activa por canal: no duplica reproductores ni usa doble login simultáneo.
 * - Stage B mantiene el transporte SRT separado del scraper; si TDMax falla, el VPS no recibe
 *   reconexiones agresivas del FFmpeg principal.
 * - Stage A muere y re-scrapea solo ante error real, stall de frames o refresh manual.
 * - Puertos fijos: FOX+ = 9005, FOX = 9006.
 *
 * Variables en /etc/fox-srt-pusher.env:
 *   VPS_HOST, VPS_PORT, SRT_STREAMID, SRT_LATENCY_MS, SRT_PASSPHRASE
 *   LOCAL_UDP_PORT, TDMAX_EMAIL, TDMAX_PASSWORD, DEVICE_ID
 *   STALL_TIMEOUT_MS, STARTUP_DELAY_MS, LOG_VERBOSE
 */

'use strict';

const { spawn } = require('child_process');
const https = require('https');

const CHANNEL_NAME = 'FOX';
const CHANNEL_ID = '664237788f085ac1f2a15f81';
const PI_TARGET = 'fox';

const VPS_HOST = process.env.VPS_HOST || '167.17.69.116';
const VPS_PORT = process.env.VPS_PORT || '9006';
const SRT_STREAMID = process.env.SRT_STREAMID || 'fox';
const LEGACY_LATENCY_US = parseInt(process.env.SRT_LATENCY_US || '', 10);
const SRT_LATENCY_MS = String(Math.max(500, parseInt(
  process.env.SRT_LATENCY_MS || (Number.isFinite(LEGACY_LATENCY_US) ? String(Math.round(LEGACY_LATENCY_US / 1000)) : '8000'),
  10,
) || 8000));
const SRT_PASSPHRASE = process.env.SRT_PASSPHRASE || '';
const LOCAL_UDP_PORT = process.env.LOCAL_UDP_PORT || '10006';
const TDMAX_EMAIL = process.env.TDMAX_EMAIL || '';
const TDMAX_PASSWORD = process.env.TDMAX_PASSWORD || '';
const DEVICE_ID = process.env.DEVICE_ID || '2f64f7b8-7d75-4cf4-9a8c-b7e2e99a9006';
const LOG_VERBOSE = process.env.LOG_VERBOSE === '1';
const STALL_TIMEOUT_MS = Math.max(15000, parseInt(process.env.STALL_TIMEOUT_MS || '25000', 10) || 25000);
const STARTUP_DELAY_MS = Math.max(0, parseInt(process.env.STARTUP_DELAY_MS || '0', 10) || 0);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const RESELLER_ID = '61316705e4b0295f87dae396';
const BASE_URL = 'https://cf.streann.tech';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  Origin: 'https://www.app.tdmax.com',
  Referer: 'https://www.app.tdmax.com/',
  'x-app-name': 'TDMAX',
  'x-app-platform': 'web',
  'x-app-version': '3.1.1',
};

if (!TDMAX_EMAIL || !TDMAX_PASSWORD) {
  console.error('❌ Falta TDMAX_EMAIL / TDMAX_PASSWORD');
  process.exit(1);
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] ⚠️ `, ...a);
const err = (...a) => console.error(`[${ts()}] ❌`, ...a);

let lastBaseHost = '';
let bridgeProc = null;
let sourceProc = null;
let stopRequested = false;
let backoffMs = 3000;
let sourceRetryTimer = null;
let bridgeRetryTimer = null;
let watchdogTimer = null;
let lastProgressAt = 0;
let lastFrame = 0;
let startingSource = false;
let manualRefreshRequested = false;

// 🔒 Una sola sesión TDMax/Nimble por canal: se reutiliza hasta que caiga por auth o refresh manual.
// No hay TTL artificial: el objetivo es comportarse como TDMax 1 en el VPS, no crear sesiones nuevas por cada restart.
let cachedHlsSession = null;
let forceRescrape = false;
let recentAuthError = false;

function normalizeSetCookie(setCookie) {
  if (!setCookie) return [];
  return Array.isArray(setCookie) ? setCookie : [setCookie];
}

function mergeCookies(existingCookieHeader = '', setCookie = []) {
  const jar = new Map();
  for (const part of String(existingCookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [name, ...valueParts] = trimmed.split('=');
    jar.set(name.trim(), valueParts.join('=').trim());
  }
  for (const raw of normalizeSetCookie(setCookie)) {
    const first = String(raw).split(';')[0]?.trim();
    if (!first || !first.includes('=')) continue;
    const [name, ...valueParts] = first.split('=');
    jar.set(name.trim(), valueParts.join('=').trim());
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

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
        try { resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpHead(url, headers, maxBytes = 65536, redirectsLeft = 3, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    let cookies = cookieHeader || '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      try { req.destroy(); } catch {}
    };
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) },
      timeout: 15000,
    }, (res) => {
      cookies = mergeCookies(cookies, res.headers['set-cookie']);
      // Seguir redirects 30x
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        settled = true;
        try { req.destroy(); } catch {}
        const next = new URL(res.headers.location, url).toString();
        return httpHead(next, headers, maxBytes, redirectsLeft - 1, cookies).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length >= maxBytes) finish({ status: res.statusCode, body: data, cookies });
      });
      res.on('end', () => finish({ status: res.statusCode, body: data, cookies }));
      res.on('close', () => finish({ status: res.statusCode, body: data, cookies }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { if (!settled) reject(e); });
    req.end();
  });
}

function absolutizeHlsUrl(child, baseUrl) {
  const url = new URL(child, baseUrl);
  const base = new URL(baseUrl);
  if (!url.search && base.search) url.search = base.search;
  return url.toString();
}

function parseMasterVariants(body, baseUrl) {
  const variants = [];
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/i)?.[1] || 0);
      const resolution = line.match(/RESOLUTION=(\d+x\d+)/i)?.[1] || '';
      const height = Number(resolution.split('x')[1] || 0);
      pending = { bandwidth, resolution, height };
      continue;
    }
    if (pending && !line.startsWith('#')) {
      variants.push({ ...pending, url: absolutizeHlsUrl(line, baseUrl) });
      pending = null;
    }
  }
  return variants;
}

function chooseBestVariant(variants) {
  const scored = variants.map((variant) => {
    const height = variant.height || 0;
    const bandwidth = variant.bandwidth || 0;
    const heightPenalty = height > 720 ? 100000000 : 0;
    const targetPenalty = Math.abs((bandwidth || 2500000) - 2500000);
    return { variant, score: heightPenalty + targetPenalty };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.variant || variants[0];
}

async function resolvePlayableHlsUrl(url, cookies = '') {
  let currentUrl = url;
  let currentCookies = cookies || '';
  for (let depth = 0; depth < 3; depth += 1) {
    const res = await httpHead(currentUrl, BROWSER_HEADERS, 131072, 3, currentCookies);
    currentCookies = res.cookies || currentCookies;
    const body = String(res.body || '');
    if (res.status !== 200 || !body.trimStart().startsWith('#EXTM3U') || /#EXT-X-ENDLIST/i.test(body)) {
      throw new Error(`Playlist inválida (HTTP ${res.status})`);
    }
    // Prioridad: si es master (tiene STREAM-INF) → SIEMPRE bajar a una variante única.
    // Solo si NO hay variantes, lo tratamos como media playlist directa.
    const variants = parseMasterVariants(body, currentUrl);
    if (variants.length > 0) {
      const selected = chooseBestVariant(variants);
      log(`🧭 ${CHANNEL_NAME}: master HLS → variante única ${selected.resolution || '?'} ${selected.bandwidth || 0}bps`);
      currentUrl = selected.url;
      continue;
    }
    if (/#EXTINF:/i.test(body) || /#EXT-X-TARGETDURATION/i.test(body)) return { url: currentUrl, cookies: currentCookies };
    throw new Error('Playlist sin variantes ni segmentos');
  }
  throw new Error('Demasiados masters HLS anidados');
}

async function getStreamHlsUrl() {
  const loginBody = JSON.stringify({ username: TDMAX_EMAIL.toLowerCase(), password: TDMAX_PASSWORD });
  const loginRes = await httpJson(
    'POST',
    `${BASE_URL}/web/services/v3/external/login?r=${RESELLER_ID}`,
    { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
    loginBody,
  );
  const token = loginRes.body?.accessToken || loginRes.body?.access_token;
  if (!token) throw new Error(`Login fallido (status ${loginRes.status}): ${JSON.stringify(loginRes.body).slice(0, 200)}`);
  let cookieHeader = mergeCookies('', loginRes.headers?.['set-cookie']);

  const qs = new URLSearchParams({
    r: RESELLER_ID,
    'device-id': DEVICE_ID,
    access_token: token,
    country_code: 'CR',
    doNotUseRedirect: 'true',
    'device-name': 'web',
    'device-type': 'web',
  });
  const lbHeaders = { ...BROWSER_HEADERS, Authorization: `Bearer ${token}`, ...(cookieHeader ? { Cookie: cookieHeader } : {}) };
  const lbRes = await httpJson('GET', `${BASE_URL}/loadbalancer/services/v1/channels-secure/${CHANNEL_ID}/playlist.m3u8?${qs}`, lbHeaders);
  cookieHeader = mergeCookies(cookieHeader, lbRes.headers?.['set-cookie']);
  const streamUrl = lbRes.body?.url;
  if (!streamUrl) throw new Error(`LB sin URL (status ${lbRes.status}): ${JSON.stringify(lbRes.body).slice(0, 200)}`);
  if (/cfvod\.streann\.tech|isVodPlaylist=true|unavailable|placeholder|slate/i.test(streamUrl)) {
    throw new Error(`TDMax devolvió placeholder/VOD: ${streamUrl.slice(0, 160)}`);
  }

  const resolved = await resolvePlayableHlsUrl(streamUrl, cookieHeader);
  return { ...resolved, accessToken: token, createdAt: Date.now() };
}

function buildSrtUrl() {
  const qs = new URLSearchParams({
    mode: 'caller',
    streamid: SRT_STREAMID,
    latency: SRT_LATENCY_MS,
    pkt_size: '1316',
    transtype: 'live',
  });
  if (SRT_PASSPHRASE) {
    qs.set('pbkeylen', '16');
    qs.set('passphrase', SRT_PASSPHRASE);
  }
  return `srt://${VPS_HOST}:${VPS_PORT}?${qs.toString()}`;
}

function isAlive(proc) {
  return proc && proc.exitCode === null && !proc.killed;
}

function killProc(proc, label, signal = 'SIGTERM') {
  if (!isAlive(proc)) return;
  try { proc.kill(signal); }
  catch (e) { if (LOG_VERBOSE) warn(`No pude enviar ${signal} a ${label}: ${e.message}`); }
  setTimeout(() => {
    if (isAlive(proc)) {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }, 2500).unref?.();
}

function clearSourceWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function killSource(signal = 'SIGTERM') {
  if (sourceRetryTimer) clearTimeout(sourceRetryTimer);
  sourceRetryTimer = null;
  clearSourceWatchdog();
  killProc(sourceProc, 'Stage A FFmpeg', signal);
}

function scheduleSourceRetry(delayMs = backoffMs) {
  if (stopRequested || !isAlive(bridgeProc)) return;
  if (sourceRetryTimer) clearTimeout(sourceRetryTimer);
  sourceRetryTimer = setTimeout(() => {
    sourceRetryTimer = null;
    runSourceOnce();
  }, delayMs);
}

function handleRelevantFfmpegLine(line) {
  const frameMatch = line.match(/^frame=(\d+)/m) || line.match(/frame=\s*(\d+)/);
  if (frameMatch) {
    const frame = Number(frameMatch[1]);
    if (frame > lastFrame) {
      lastFrame = frame;
      lastProgressAt = Date.now();
    }
    return;
  }
  if (/^out_time_ms=\d+/m.test(line) || /^progress=continue/m.test(line)) {
    lastProgressAt = Date.now();
    return;
  }
  // Detección de errores de auth → invalida caché de sesión TDMax/Nimble
  if (/HTTP\s*(401|403|410)|403 Forbidden|401 Unauthorized|410 Gone/i.test(line)) {
    recentAuthError = true;
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    return;
  }
  if (LOG_VERBOSE) {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
    return;
  }
  if (/HTTP\s*(404)|invalid data|server returned|error|fail|denied|broken|Connection timed out|Connection reset/i.test(line)) {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  }
}

function spawnSourceFfmpeg(session) {
  const hlsUrl = session.url;
  const udpUrl = `udp://127.0.0.1:${LOCAL_UDP_PORT}?pkt_size=1316&buffer_size=655360`;
  log(`▶️  Stage A ${CHANNEL_NAME}: TDMax HLS → UDP local:${LOCAL_UDP_PORT}`);

  const headerLines = [
    `Referer: ${BROWSER_HEADERS.Referer}`,
    `Origin: ${BROWSER_HEADERS.Origin}`,
    session.accessToken ? `Authorization: Bearer ${session.accessToken}` : null,
  ].filter(Boolean).join('\r\n') + '\r\n';

  const args = [
    '-hide_banner', '-nostdin', '-loglevel', LOG_VERBOSE ? 'info' : 'warning',
    '-progress', 'pipe:2', '-stats_period', '5', '-nostats',
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-rw_timeout', '15000000',
    '-user_agent', BROWSER_HEADERS['User-Agent'],
    ...(session.cookies ? ['-cookies', `${session.cookies}\n`] : []),
    '-headers', headerLines,
    // Modo VLC-like/TDMax 1: el demuxer HLS maneja playlist/segmentos; no forzamos reconnect HTTP agresivo.
    '-http_seekable', '0',
    '-max_reload', '1000',
    '-m3u8_hold_counters', '1000',
    '-re',
    '-i', hlsUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-bsf:v', 'h264_mp4toannexb',
    '-mpegts_flags', '+resend_headers',
    '-f', 'mpegts',
    '-flush_packets', '1',
    udpUrl,
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) handleRelevantFfmpegLine(line);
    }
  });
  return proc;
}

async function runSourceOnce() {
  if (stopRequested || startingSource || isAlive(sourceProc) || !isAlive(bridgeProc)) return;
  startingSource = true;
  let session;
  try {
    const cacheValid = cachedHlsSession?.url && !forceRescrape && !recentAuthError;
    if (cacheValid) {
      session = cachedHlsSession;
      const ageMin = Math.round((Date.now() - session.createdAt) / 60000);
      log(`♻️  ${CHANNEL_NAME}: reusando la MISMA sesión TDMax/Nimble (edad=${ageMin}min). Sin login nuevo.`);
    } else {
      if (recentAuthError) warn(`${CHANNEL_NAME}: error de auth detectado → re-login TDMax forzado.`);
      else if (forceRescrape) warn(`${CHANNEL_NAME}: refresh manual → re-login TDMax.`);
      session = await getStreamHlsUrl();
      cachedHlsSession = session;
      forceRescrape = false;
      recentAuthError = false;
      const newHost = new URL(session.url).host;
      if (lastBaseHost && newHost !== lastBaseHost) log(`🔄 ${CHANNEL_NAME}: TDMax rotó CDN ${lastBaseHost} → ${newHost}`);
      lastBaseHost = newHost;
      log(`🔑 ${CHANNEL_NAME}: nueva sesión TDMax/Nimble obtenida; se reusará hasta que caiga por auth o refresh manual.`);
    }
    backoffMs = 3000;
  } catch (e) {
    startingSource = false;
    err(`${CHANNEL_NAME}: scrape TDMax falló: ${e.message}`);
    warn(`${CHANNEL_NAME}: reintento en ${Math.round(backoffMs / 1000)}s`);
    scheduleSourceRetry(backoffMs);
    backoffMs = Math.min(Math.round(backoffMs * 1.5), 45000);
    return;
  }

  startingSource = false;
  lastProgressAt = Date.now();
  lastFrame = 0;
  sourceProc = spawnSourceFfmpeg(session);

  watchdogTimer = setInterval(() => {
    if (!isAlive(sourceProc)) return;
    const quietFor = Date.now() - lastProgressAt;
    if (quietFor >= STALL_TIMEOUT_MS) {
      warn(`${CHANNEL_NAME}: Stage A sin frames por ${Math.round(quietFor / 1000)}s; reinicio limpio sin tumbar Stage B SRT.`);
      backoffMs = 1000;
      killSource('SIGTERM');
    }
  }, 5000);
  watchdogTimer.unref?.();

  sourceProc.on('exit', (code, signal) => {
    sourceProc = null;
    clearSourceWatchdog();
    if (stopRequested || !isAlive(bridgeProc)) return;
    const delay = manualRefreshRequested ? 1000 : backoffMs;
    manualRefreshRequested = false;
    warn(`${CHANNEL_NAME}: Stage A salió (code=${code ?? '-'}${signal ? `, signal=${signal}` : ''}); reinicio en ${Math.round(delay / 1000)}s usando sesión cacheada si sigue válida`);
    scheduleSourceRetry(delay);
    backoffMs = Math.min(Math.round(backoffMs * 1.5), 45000);
  });
}

function handleBridgeOutput(chunk) {
  if (LOG_VERBOSE) process.stderr.write(chunk.toString());
}

function startBridge() {
  if (stopRequested || isAlive(bridgeProc)) return;
  if (bridgeRetryTimer) clearTimeout(bridgeRetryTimer);
  bridgeRetryTimer = null;

  const inputUrl = `udp://:${LOCAL_UDP_PORT}?pkt_size=1316`;
  const outputUrl = buildSrtUrl();
  log(`🛰️  Stage B ${CHANNEL_NAME}: UDP local:${LOCAL_UDP_PORT} → SRT ${VPS_HOST}:${VPS_PORT} (latency=${SRT_LATENCY_MS}ms)`);

  bridgeProc = spawn('srt-live-transmit', [inputUrl, outputUrl, '-loglevel:warning', '-stats-report-frequency:5000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridgeProc.stdout.on('data', handleBridgeOutput);
  bridgeProc.stderr.on('data', handleBridgeOutput);

  const sourceStartTimer = setTimeout(() => {
    if (isAlive(bridgeProc) && !isAlive(sourceProc)) runSourceOnce();
  }, 1500);
  sourceStartTimer.unref?.();

  bridgeProc.on('exit', (code, signal) => {
    bridgeProc = null;
    killSource('SIGTERM');
    if (stopRequested) return;
    warn(`${CHANNEL_NAME}: Stage B SRT cayó (code=${code ?? '-'}${signal ? `, signal=${signal}` : ''}); reabriendo en 5s`);
    bridgeRetryTimer = setTimeout(startBridge, 5000);
    bridgeRetryTimer.unref?.();
  });
}

function supaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return reject(new Error('Backend no configurado'));
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
      timeout: 10000,
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
    await supaRequest('PATCH', `/rest/v1/pi5_commands?id=eq.${cmd.id}`, {
      consumed_at: new Date().toISOString(),
      consumed_by: PI_TARGET,
    });
    if (cmd.command === 'refresh') {
      manualRefreshRequested = true;
      forceRescrape = true;
      backoffMs = 1000;
      if (isAlive(sourceProc)) {
        log(`🔄 Refresh manual ${CHANNEL_NAME}: reinicio Stage A + token; Stage B SRT queda arriba.`);
        killSource('SIGTERM');
      } else if (isAlive(bridgeProc)) {
        log(`🔄 Refresh manual ${CHANNEL_NAME}: Stage A no activo; iniciando re-scrape.`);
        scheduleSourceRetry(1000);
      }
    }
  } catch (e) {
    if (LOG_VERBOSE) warn(`pollCommands: ${e.message}`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`📴 ${sig} recibido — apagando ${CHANNEL_NAME}…`);
    stopRequested = true;
    if (sourceRetryTimer) clearTimeout(sourceRetryTimer);
    if (bridgeRetryTimer) clearTimeout(bridgeRetryTimer);
    killSource('SIGTERM');
    killProc(bridgeProc, 'Stage B srt-live-transmit', 'SIGTERM');
    setTimeout(() => process.exit(0), 2000).unref?.();
  });
}

process.on('uncaughtException', (e) => { err('uncaughtException:', e?.stack || e?.message || e); });
process.on('unhandledRejection', (e) => { err('unhandledRejection:', e?.stack || e?.message || e); });

log(`🚀 ${CHANNEL_NAME} robusto iniciado → VPS:${VPS_PORT}, UDP local:${LOCAL_UDP_PORT}, target=${PI_TARGET}`);
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  setInterval(pollCommands, 15000);
  log(`📡 Polling de comandos manuales activo (target=${PI_TARGET})`);
} else {
  warn('SUPABASE_URL / SUPABASE_ANON_KEY no definidos — Refresh manual no funcionará');
}

if (STARTUP_DELAY_MS > 0) {
  log(`⏳ Arranque escalonado: esperando ${Math.round(STARTUP_DELAY_MS / 1000)}s antes de abrir ${CHANNEL_NAME}`);
  setTimeout(startBridge, STARTUP_DELAY_MS);
} else {
  startBridge();
}
