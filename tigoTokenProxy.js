// tigoTokenProxy.js — Fase 2: mini-proxy HTTP local que mantiene el wmsAuthSign
// de Teletica/Tigo siempre fresco, reescribiéndolo en cada request que FFmpeg
// le hace, sin que FFmpeg jamás vea un 403 por token expirado.
//
// Flujo:
//   FFmpeg → http://127.0.0.1:<port>/<path original>
//          → proxy reescribe wmsAuthSign con el más reciente + quita nimblesessionid heredado
//          → request via Pi5 SOCKS5 → Teletica
//          → respuesta (m3u8 reescrito o segmento .ts) → FFmpeg
//
// Refresh proactivo cada REFRESH_INTERVAL_MS (50s, margen de 10s antes de los 60s).
// Si fallan >MAX_CONSECUTIVE_FAILURES, marca degraded=true; server.js debe matar
// FFmpeg para caer al modo Fase 1 puro (URL directa al CDN sin proxy local).

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

const REFRESH_INTERVAL_MS = 50_000;
const REFRESH_RETRY_DELAY_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const UPSTREAM_TIMEOUT_MS = 12_000;

function fetchUpstream(targetUrl, { headers = {}, agent, timeout = UPSTREAM_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (err) { return reject(new Error(`URL inválida: ${err.message}`)); }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(targetUrl, { method: 'GET', headers, agent, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

function extractWmsAuth(urlStr) {
  try { return new URL(urlStr).searchParams.get('wmsAuthSign'); }
  catch { return null; }
}

/**
 * @param {Object} opts
 * @param {string}   opts.initialMasterUrl
 * @param {string}   opts.proxyUrl
 * @param {string}   opts.userAgent
 * @param {string}   opts.referer
 * @param {string}   opts.origin
 * @param {string=}  opts.cookies
 * @param {string=}  opts.authorization      "Bearer ..."
 * @param {Function} opts.refreshFn          async () => ({ url, cookies?, accessToken?, error? })
 * @param {Function=} opts.onLog             (level, msg) => void
 */
export async function startTigoProxy(opts) {
  const {
    initialMasterUrl,
    proxyUrl,
    userAgent,
    referer,
    origin,
    cookies,
    authorization,
    refreshFn,
    onLog = () => {},
  } = opts;

  if (!initialMasterUrl) throw new Error('initialMasterUrl requerido');
  if (!proxyUrl) throw new Error('proxyUrl requerido');
  if (typeof refreshFn !== 'function') throw new Error('refreshFn requerido');

  const agent = new SocksProxyAgent(proxyUrl);

  let currentSign = extractWmsAuth(initialMasterUrl);
  let masterUrlBase;
  try {
    masterUrlBase = new URL(initialMasterUrl);
    masterUrlBase.searchParams.delete('wmsAuthSign');
    masterUrlBase.searchParams.delete('nimblesessionid');
  } catch {
    throw new Error('initialMasterUrl no parseable');
  }
  if (!currentSign) throw new Error('initialMasterUrl sin wmsAuthSign');

  let sessionCookies = cookies || null;
  let sessionAuth = authorization || null;
  let consecutiveFailures = 0;
  let degraded = false;
  let refreshTimer = null;
  let retryTimer = null;
  let lastRefreshAt = Date.now();
  let refreshCount = 0;
  let stopped = false;

  async function doRefresh() {
    if (stopped) return;
    try {
      const fresh = await refreshFn();
      if (fresh && fresh.url) {
        const newSign = extractWmsAuth(fresh.url);
        if (newSign) {
          if (newSign !== currentSign) {
            currentSign = newSign;
            refreshCount += 1;
            if (refreshCount === 1 || refreshCount % 5 === 0) {
              onLog('info', `🔄 Token refresher: ${refreshCount} rotaciones OK`);
            }
          }
          if (fresh.cookies) sessionCookies = fresh.cookies;
          if (fresh.accessToken) sessionAuth = `Bearer ${fresh.accessToken}`;
          lastRefreshAt = Date.now();
          consecutiveFailures = 0;
        } else {
          throw new Error('refresh sin wmsAuthSign');
        }
      } else {
        throw new Error(fresh?.error || 'refreshFn no devolvió URL');
      }
    } catch (err) {
      consecutiveFailures += 1;
      onLog('warn', `⚠️ Token refresher falló (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        degraded = true;
        onLog('error', `❌ Token refresher degradado. Fallback a Fase 1 requerido.`);
      } else {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(doRefresh, REFRESH_RETRY_DELAY_MS);
      }
    }
  }

  refreshTimer = setInterval(doRefresh, REFRESH_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    let upstreamUrl;
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const u = new URL(masterUrlBase.origin);
      u.pathname = reqUrl.pathname;
      // Copiar query params del request original (para preservar parámetros que el CDN espera)
      for (const [k, v] of reqUrl.searchParams) u.searchParams.set(k, v);
      // Forzar wmsAuthSign actual y limpiar nimblesessionid heredado
      u.searchParams.set('wmsAuthSign', currentSign);
      u.searchParams.delete('nimblesessionid');
      upstreamUrl = u.toString();
    } catch (err) {
      res.writeHead(400);
      return res.end(`bad request: ${err.message}`);
    }

    const upstreamHeaders = {
      'User-Agent': userAgent,
      'Referer': referer,
      'Origin': origin,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    };
    if (sessionCookies) upstreamHeaders['Cookie'] = sessionCookies;
    if (sessionAuth) upstreamHeaders['Authorization'] = sessionAuth;

    try {
      const upstream = await fetchUpstream(upstreamUrl, { headers: upstreamHeaders, agent });

      if (upstream.status >= 400) {
        consecutiveFailures += 1;
        if (upstream.status === 403) {
          onLog('warn', `⚠️ Upstream 403 (token muerto) — refresh inmediato`);
          doRefresh().catch(() => {});
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          degraded = true;
          onLog('error', `❌ Proxy degradado: ${consecutiveFailures} respuestas ${upstream.status} consecutivas`);
        }
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers['content-type'] || 'text/plain' });
        return res.end(upstream.body);
      }

      consecutiveFailures = 0;

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      let bodyOut = upstream.body;
      const isM3u8 = ct.includes('mpegurl') || /\.m3u8($|\?)/i.test(req.url);

      if (isM3u8) {
        const text = upstream.body.toString('utf8');
        const localBase = `http://127.0.0.1:${address.port}`;
        const upstreamOrigin = masterUrlBase.origin;
        const rewritten = text.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          // URL absoluta del CDN → reescribir a localhost (sin query, el proxy regenera token)
          if (trimmed.startsWith(upstreamOrigin)) {
            try {
              const u = new URL(trimmed);
              return `${localBase}${u.pathname}`;
            } catch { return line; }
          }
          if (/^https?:\/\//i.test(trimmed)) return line;
          // Relativa → FFmpeg la resuelve contra el localBase del request actual
          return line;
        }).join('\n');
        bodyOut = Buffer.from(rewritten, 'utf8');
      }

      const outHeaders = {
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      };
      if (!isM3u8 && upstream.headers['content-length']) {
        outHeaders['Content-Length'] = upstream.headers['content-length'];
      }
      res.writeHead(200, outHeaders);
      res.end(bodyOut);
    } catch (err) {
      consecutiveFailures += 1;
      onLog('warn', `⚠️ Proxy upstream error (${consecutiveFailures}): ${err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        degraded = true;
        onLog('error', `❌ Proxy degradado tras ${consecutiveFailures} errores upstream`);
      }
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('upstream error');
    }
  });

  const address = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });

  // Validación inmediata: dispara primer refresh para confirmar que el flujo funciona.
  doRefresh().catch(() => {});

  onLog('success', `🎯 Token refresher proxy escuchando en http://127.0.0.1:${address.port} (refresh ${REFRESH_INTERVAL_MS / 1000}s)`);

  const localPlaylistUrl = (() => {
    const u = new URL(initialMasterUrl);
    return `http://127.0.0.1:${address.port}${u.pathname}`;
  })();

  return {
    port: address.port,
    localPlaylistUrl,
    isDegraded: () => degraded,
    getStats: () => ({
      port: address.port,
      refreshCount,
      lastRefreshAgoSec: Math.round((Date.now() - lastRefreshAt) / 1000),
      consecutiveFailures,
      degraded,
    }),
    stop: () => new Promise((resolve) => {
      stopped = true;
      clearInterval(refreshTimer);
      clearTimeout(retryTimer);
      try { server.close(() => resolve()); } catch { resolve(); }
    }),
  };
}
