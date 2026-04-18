---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica. Fase 1 estabilidad (Apr 2026): Variant Pinning de sub-playlist 720p via Pi5 + modo VLC-like puro (sin http_persistent/multiple_requests, max_reload 8) + User-Agent rotativo de pool real por sesión. Quick Retry mantiene 5s + cache-buster anti nimblesessionid.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Tecnología del CDN
Teletica usa **Wowza Streaming Engine + Nimble Streamer** con autenticación `wmsAuthSign` y un `nimblesessionid` por sesión. El token `wmsAuthSign` se valida en CADA segmento (no solo al conectar). Wowza/Nimble detecta patrones de scraper (reload agresivo, lectura paralela de TODAS las variantes, keepalive sostenido) y aplica 403 progresivos.

## Fase 1 estabilidad (Apr 2026) — disfraz de cliente normal

**Objetivo**: parecernos a VLC/navegador, no a un re-emisor.

### 1. Variant Pinning (sub-playlist directa)
En `isScrapedChannel && isProxyScrapedSource` (server.js ~línea 1800), parseamos el master playlist via `fetchWithOptionalProxy(..., true)` (Pi5), elegimos la variante 720p y pasamos a FFmpeg directamente la `chunks.m3u8` hija (no el master). Esto evita que FFmpeg abra las 4 variantes en paralelo (Stream #0:0..#0:7), reduciendo 4x el tráfico que ve Wowza y haciéndonos ver como un cliente ABR que ya negoció calidad. Log: `📌 Tigo Variant Pinning → 1280x720 @ 2127kbps (sub-playlist directa, sin master)`.

### 2. Modo VLC-like puro
Quitamos los flags que delatan scraper:
- ❌ `-http_persistent 1` (keep-alive forzado, no es comportamiento default)
- ❌ `-multiple_requests 1` (pipelining)
- ❌ `-max_reload 1000` / `-m3u8_hold_counters 1000` (reload agresivo en bucle)

Mantenemos:
- ✅ `-max_reload 8` y `-m3u8_hold_counters 10` (moderados — sobreviven 1-2 reloads de token sin parecer agresivos)
- ✅ `live_start_index` dinámico (-2 manual, -1 recovery)
- ✅ `-rtbufsize 512M` + `-thread_queue_size 16384` (jitter SOCKS5)
- ✅ `-max_delay 5000000` + `+genpts+discardcorrupt`

### 3. User-Agent rotativo
Pool de 6 UAs reales (Chrome Win/Mac, Edge, Safari, Firefox) en `REAL_USER_AGENTS`. `pickRandomUserAgent()` se llama por sesión (cada arranque/recovery) y se aplica tanto al fetch del master via Pi5 como al `-user_agent` de FFmpeg. Cada reconexión = "cliente nuevo" para Wowza. Log: `🎭 UA rotativo: ...`.

## Anti doble-scrape (sigue vigente)
En `/api/emit`, si `is_recovery=true` Y `scrapeSessionCache` <10s, se reusa la URL recibida y se salta el refresh JIT.

## Anti nimblesessionid heredado (sigue vigente)
**Quick Retry de Tigo**:
1. **Delay 5s** antes del retry (vs 500ms en otros procesos). Da tiempo a Wowza para liberar el estado de la sesión Nimble anterior.
2. **Cache-buster** `&_t=<Date.now()>` al URL fresca antes de pasarla a FFmpeg, forzando a Wowza a tratar el master como nuevo.

## Health-check del proxy
- `checkProxyHealth()`: TCP connect al puerto 1080, timeout 4s.
- Monitor pasivo cada 60s. Pre-spawn valida proxy; si está caído marca `failure_reason='proxy_down'`.

## Mensajes de fallo TIGO
`getFailureDescription` distingue `processIndex === 12`: `proxy_down`, `eof` (token 60s/microcorte/Teletica), default menciona proxy/token/Teletica/CDN.

## Fase 2 (POSPUESTA, considerar si Fase 1 no estabiliza >4h)
Token refresher proactivo via mini-proxy HTTP local: re-scrape cada 45s (margen 15s antes de expiración) y hot-swap de URL sin reiniciar FFmpeg. Es la causa raíz pero agrega complejidad — solo justificable si Fase 1 demuestra ser insuficiente.
