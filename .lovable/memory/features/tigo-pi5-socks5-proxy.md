---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) usa Pi5 SOCKS5 + Fase 2 (mini-proxy local con token refresher proactivo cada 50s + hot-swap de wmsAuthSign sin reiniciar FFmpeg). Fallback automático a Fase 1 (proxychains4 directo) si el mini-proxy se degrada.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Tecnología del CDN
Teletica usa **Wowza Streaming Engine + Nimble Streamer** con autenticación `wmsAuthSign` y un `nimblesessionid` por sesión. El token `wmsAuthSign` se valida en CADA segmento (no solo al conectar) y dura **60s** (`validminutes=1`). Wowza/Nimble detecta patrones de scraper (reload agresivo, lectura paralela de TODAS las variantes, keepalive sostenido) y aplica 403 progresivos.

## FASE 2 (Apr 2026, vigente) — Mini-proxy local con token refresher

**Módulo**: `tigoTokenProxy.js` (ESM). Importado en server.js y orquestado vía `tigoProxies` Map y helper `stopTigoProxy(process_id)`.

### Arquitectura
```
FFmpeg (local, sin proxychains4)
  → http://127.0.0.1:<puerto efímero>/<path original>
  → tigoTokenProxy reescribe wmsAuthSign al actual + quita nimblesessionid heredado
  → http(s) request via SocksProxyAgent (Pi5 CR)
  → Teletica CDN
  → respuesta (m3u8 reescrito a 127.0.0.1 / segmento .ts) → FFmpeg
```

### Refresh proactivo
- Cada **50s** (`REFRESH_INTERVAL_MS`, margen de 10s antes de la expiración natural de 60s).
- `refreshFn` reusa `scrapeStreamUrlLocal(channelId, channelName, { useProxy: true })` (mismo flujo de login + token via Pi5 que ya existía en `/api/emit`).
- Tras refresh OK: actualiza `currentSign`, `sessionCookies`, `sessionAuth` y `scrapeSessionCache` (para que el Quick Retry futuro lo reuse).
- Si refresh falla: reintento inmediato a los 5s. Tras 3 fallos consecutivos → `degraded=true`.
- Si upstream devuelve 403 en cualquier request: dispara refresh inmediato (no espera al ciclo).

### Reescritura de m3u8
Cuando upstream devuelve un playlist (master o sub), las URLs absolutas que apuntan al origen del CDN se reescriben a `http://127.0.0.1:<port><pathname>` (sin query). Las relativas se dejan tal cual (FFmpeg las resuelve contra el localBase del request actual). Resultado: **todos los requests de FFmpeg —incluyendo segmentos .ts— pasan por el proxy local**, garantizando que cada uno reciba el `wmsAuthSign` actual.

### Fallback automático (degraded → Fase 1)
- En spawn de FFmpeg, un `setInterval(3000ms)` chequea `proxy.isDegraded()`.
- Si está degradado: cierra el proxy, mata FFmpeg con SIGTERM. El exit handler dispara Quick Retry. Como `tigoProxies.has(process_id)` ahora es false, el spawn se hace con `proxychains4 -f /tmp/proxychains-tigo.conf ffmpeg ...` (Fase 1 puro). Garantiza que el peor caso = Fase 1, no peor.

### Variant Pinning (preservado de Fase 1)
Antes de arrancar el proxy, parseamos el master via `fetchWithOptionalProxy(..., true)` y extraemos la URL de la variante 720p. Esa URL es la `initialMasterUrl` que recibe el proxy. Resultado: FFmpeg ve solo 1 video + 1 audio (no 4 variantes paralelas).

### User-Agent rotativo (preservado de Fase 1)
Pool de 6 UAs reales en `REAL_USER_AGENTS`. `pickRandomUserAgent()` se llama por sesión y se inyecta tanto al fetch del master como al header `User-Agent` que el proxy local manda al CDN en cada request.

### FFmpeg flags (modo VLC-like puro, preservado de Fase 1)
- ✅ `-max_reload 8`, `-m3u8_hold_counters 10`
- ✅ `live_start_index` dinámico (-2 manual, -1 recovery)
- ✅ `-rtbufsize 512M`, `-thread_queue_size 16384`
- ❌ Sin `-http_persistent`, `-multiple_requests`, `-reconnect_*` (el proxy local maneja resiliencia)

## proxychains4 — solo en fallback
Cuando `tigoProxies.has(process_id) === true`, el spawn de FFmpeg es directo (`spawnCmd = 'ffmpeg'`). NO se envuelve con `proxychains4`. Solo en el modo Fase 1 fallback se usa `proxychains4 -q -f /tmp/proxychains-tigo.conf ffmpeg ...`.

## Anti doble-scrape (preservado)
En `/api/emit`, si `is_recovery=true` Y `scrapeSessionCache` <10s → reusa la URL recibida. La Fase 2 también escribe en `scrapeSessionCache` cada refresh exitoso, así el Quick Retry encuentra siempre token fresco.

## Anti nimblesessionid heredado (preservado)
**Quick Retry de Tigo**:
1. Delay 5s antes del retry (vs 500ms en otros procesos).
2. Cache-buster `&_t=<Date.now()>` al URL fresca antes de pasarla al `/api/emit`.

## Health-check del proxy SOCKS5
- `checkProxyHealth()`: TCP connect al puerto 1080, timeout 4s.
- Pre-spawn valida proxy. Si está caído → `failure_reason='proxy_down'` y se cierra el mini-proxy.

## Mensajes de fallo TIGO
`getFailureDescription` distingue `processIndex === 12`: `proxy_down`, `eof` (token 60s/microcorte/Teletica), default menciona proxy/token/Teletica/CDN.

## Logs clave (Fase 2)
- `🛡️ FASE 2 activa: FFmpeg → http://127.0.0.1:<port>/... (token auto-refresh)`
- `🎯 Token refresher proxy escuchando en http://127.0.0.1:<port> (refresh 50s)`
- `🔄 Token refresher: N rotaciones OK` (cada 5 refresh, no spam)
- `🛡️ FFmpeg consumirá del proxy local (Fase 2 activa)`
- Fallback: `⚠️ FASE 2 falló al iniciar (...) — usando URL directa (Fase 1)` o `🚨 Mini-proxy Tigo degradado — matando FFmpeg para rebotar a Fase 1`
