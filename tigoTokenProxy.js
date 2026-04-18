// tigoTokenProxy.js — Fase 2: mini-proxy HTTP local que mantiene el wmsAuthSign
// de Teletica/Tigo siempre fresco, reescribiéndolo en cada request que FFmpeg
// le hace, sin que FFmpeg jamás vea un 403 por token expirado.
//
// Flujo:
//   FFmpeg → http://127.0.0.1:<port>/playlist.m3u8
//          → proxy reescribe wmsAuthSign con el más reciente
//          → request via Pi5 SOCKS5 → Teletica
//          → respuesta (m3u8 o segmento .ts) → FFmpeg
//
// El refresh proactivo del token corre cada REFRESH_INTERVAL_MS (50s, margen
// de 10s antes de la expiración natural de 60s). Usa la `refreshFn` provista
// por el caller (que reusa el flujo existente de scraping vía Pi5).
//
// Si el proxy detecta >MAX_CONSECUTIVE_FAILURES errores upstream, marca
// `degraded=true`. server.js debe vigilar `proxy.isDegraded()` y matar
// FFmpeg para caer al modo Fase 1 puro (URL directa al CDN).

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');

const REFRESH_INTERVAL_MS = 50_000;       // refresh proactivo (token dura 60s)
const REFRESH_RETRY_DELAY_MS = 5_000;     // si falla, reintenta a los 5s
const MAX_CONSECUTIVE_FAILURES = 3;       // umbral para marcar degraded
const UPSTREAM_TIMEOUT_MS = 12_000;

// Helper: construye un Promise sobre http(s).request usando un agent dado.
function fetchUpstream(targetUrl, { headers = {}, agent, timeout = UPSTREAM_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return reject(new Error(`URL inválida: ${err.message}`));
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(targetUrl, {
      method: 'GET',
      headers,
      agent,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Reemplaza (o agrega) el parámetro wmsAuthSign en una URL.
function rewriteWmsAuth(urlStr, freshSign) {
  try {
    const u = new URL(urlStr);
    u.searchParams.set('wmsAuthSign', freshSign);
    // Quitar nimblesessionid: lo asigna el CDN al recibir el master fresco.
    u.searchParams.delete('nimblesessionid');
    return u.toString();
  } catch {
    return urlStr;
  }
}

// Extrae wmsAuthSign de una URL (o null si no existe).
function extractWmsAuth(urlStr) {
  try {
    return new URL(urlStr).searchParams.get('wmsAuthSign');
  } catch { return null; }
}

/**
 * Inicia el mini-proxy local para una sesión Tigo.
 *
 * @param {Object} opts
 * @param {string} opts.initialMasterUrl   - URL master (ya con wmsAuthSign vigente).
 * @param {string} opts.proxyUrl           - socks5h://... del Pi5 CR.
 * @param {string} opts.userAgent          - UA de la sesión.
 * @param {string} opts.referer
 * @param {string} opts.origin
 * @param {string} [opts.cookies]          - Cookie header (opcional).
 * @param {string} [opts.authorization]    - "Bearer ..." (opcional).
 * @param {Function} opts.refreshFn        - async () => ({ url, cookies?, accessToken? })
 *                                           Debe re-scrapear via Pi5 y devolver
 *                                           el master URL nuevo con wmsAuthSign fresco.
 * @param {Function} [opts.onLog]          - (level, msg) => void
 * @returns {Promise<TigoProxy>}
 */
async function startTigoProxy(opts) {
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

  // Estado mutable de la sesión.
  let currentSign = extractWmsAuth(initialMasterUrl);
  let masterUrlBase = (() => {
    try {
      const u = new URL(initialMasterUrl);
      u.searchParams.delete('wmsAuthSign');
      u.searchParams.delete('nimblesessionid');
      return u; // mantener objeto para reusar pathname/host
    } catch { return null; }
  })();
  let sessionCookies = cookies || null;
  let sessionAuth = authorization || null;
  let consecutiveFailures = 0;
  let degraded = false;
  let refreshTimer = null;
  let retryTimer = null;
  let lastRefreshAt = Date.now();
  let refreshCount = 0;

  if (!currentSign || !masterUrlBase) {
    throw new Error('initialMasterUrl no contiene wmsAuthSign válido');
  }

  // Refresh proactivo del token via re-scrape Pi5.
  async function doRefresh() {
    try {
      const fresh = await refreshFn();
      if (fresh && fresh.url) {
        const newSign = extractWmsAuth(fresh.url);
        if (newSign && newSign !== currentSign) {
          currentSign = newSign;
          if (fresh.cookies) sessionCookies = fresh.cookies;
          if (fresh.accessToken) sessionAuth = `Bearer ${fresh.accessToken}`;
          lastRefreshAt = Date.now();
          refreshCount += 1;
          // No log por cada refresh para no spamear; cada 5.
          if (refreshCount === 1 || refreshCount % 5 === 0) {
            onLog('info', `🔄 Token refresher: ${refreshCount} refresh OK (último wmsAuthSign rotado)`);
          }
          consecutiveFailures = 0;
        } else {
          // Token igual = backend devolvió mismo string; no es fallo crítico.
          lastRefreshAt = Date.now();
        }
      } else {
        throw new Error(fresh?.error || 'refreshFn no devolvió URL');
      }
    } catch (err) {
      consecutiveFailures += 1;
      onLog('warn', `⚠️ Token refresher falló (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        degraded = true;
        onLog('error', `❌ Token refresher degradado tras ${consecutiveFailures} fallos. server.js debe rebotar a Fase 1.`);
      }
      // Reintentar pronto (no esperar al ciclo completo).
      if (!degraded) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(doRefresh, REFRESH_RETRY_DELAY_MS);
      }
    }
  }

  // Loop periódico.
  refreshTimer = setInterval(doRefresh, REFRESH_INTERVAL_MS);

  // ── HTTP server local ──
  const server = http.createServer(async (req, res) => {
    // Cualquier path es válido — usamos el pathname para mapear al upstream.
    // Estrategia: el path entrante (ej: /tigosport/tigosport_1/chunks.m3u8)
    // se concatena con el host base de masterUrlBase. Reescribimos siempre
    // el wmsAuthSign al actual.
    let upstreamUrl;
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);
      // Construir URL upstream: mismo origin que el master, pathname del request.
      const u = new URL(masterUrlBase.origin);
      u.pathname = reqUrl.pathname;
      // Copiar query params del request original (FFmpeg a veces resuelve URLs relativas
      // y mantiene el wmsAuthSign viejo embebido). Lo sobrescribimos abajo.
      for (const [k, v] of reqUrl.searchParams) {
        u.searchParams.set(k, v);
      }
      // Forzar wmsAuthSign fresco + quitar nimblesessionid heredado.
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
        // 403 = token muerto. Forzar refresh inmediato.
        if (upstream.status === 403) {
          onLog('warn', `⚠️ Upstream 403 (token muerto) — forzando refresh inmediato`);
          doRefresh().catch(() => {});
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          degraded = true;
          onLog('error', `❌ Proxy degradado: ${consecutiveFailures} respuestas ${upstream.status} consecutivas`);
        }
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers['content-type'] || 'text/plain' });
        return res.end(upstream.body);
      }

      // Reset contador en éxito.
      consecutiveFailures = 0;

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      let bodyOut = upstream.body;

      // Si es un m3u8, reescribir URLs absolutas internas para que apunten al proxy local.
      // Así FFmpeg pide siempre via 127.0.0.1 y nosotros reescribimos el token cada vez.
      if (ct.includes('mpegurl') || req.url.endsWith('.m3u8')) {
        const text = upstream.body.toString('utf8');
        const localBase = `http://127.0.0.1:${address.port}`;
        const upstreamOrigin = masterUrlBase.origin;
        const rewritten = text.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          // URL absoluta del CDN → reescribir a localhost (mismo path, sin query — el proxy lo regenera)
          if (trimmed.startsWith(upstreamOrigin)) {
            try {
              const u = new URL(trimmed);
              return `${localBase}${u.pathname}`;
            } catch { return line; }
          }
          // URL absoluta de cualquier otro origin (raro): dejar pasar.
          if (/^https?:\/\//i.test(trimmed)) return line;
          // URL relativa: dejarla — FFmpeg la resolverá contra el localBase del request actual.
          return line;
        }).join('\n');
        bodyOut = Buffer.from(rewritten, 'utf8');
      }

      // Pasar respuesta a FFmpeg.
      const outHeaders = {
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      };
      // No reenviar Content-Length original si reescribimos.
      if (!ct.includes('mpegurl')) {
        if (upstream.headers['content-length']) {
          outHeaders['Content-Length'] = upstream.headers['content-length'];
        }
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
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('upstream error');
    }
  });

  // Bind a puerto efímero, solo loopback.
  const address = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });

  // Disparar primer refresh inmediato (en background) para validar que funciona.
  doRefresh().catch(() => {});

  onLog('success', `🎯 Token refresher proxy escuchando en http://127.0.0.1:${address.port} (refresh cada ${REFRESH_INTERVAL_MS / 1000}s)`);

  // URL local que FFmpeg debe consumir: misma pathname del master original.
  const localPlaylistUrl = (() => {
    const u = new URL(initialMasterUrl);
    return `http://127.0.0.1:${address.port}${u.pathname}`;
  })();

  /** @type {TigoProxy} */
  const handle = {
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
      clearInterval(refreshTimer);
      clearTimeout(retryTimer);
      try { server.close(() => resolve()); } catch { resolve(); }
    }),
  };

  return handle;
}

module.exports = { startTigoProxy };
