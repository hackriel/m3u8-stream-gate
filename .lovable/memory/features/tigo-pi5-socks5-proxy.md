---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) usa Pi5 SOCKS5 + Fase 1 endurecida (proxychains4 → CDN, sin mini-proxy local). Variant Pinning manual a 720p, max_reload=50, m3u8_hold_counters=50, watchdog stall 120s. Fase 2 (mini-proxy con token refresher) fue probada y revertida — incompatible con nimblesessionid de Wowza.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Tecnología del CDN
Teletica usa **Wowza Streaming Engine + Nimble Streamer** con autenticación `wmsAuthSign` y un `nimblesessionid` por sesión. El token `wmsAuthSign` se valida en CADA segmento (no solo al conectar) y dura **60s** (`validminutes=1`). El `nimblesessionid` es **estático por sesión**: cada sesión nueva tiene nombres de segmento distintos (`l_2104_XXXX_N.ts`). Wowza/Nimble detecta patrones de scraper (reload agresivo, lectura paralela de variantes, keepalive sostenido) y aplica 403 progresivos.

## FASE 2 (Apr 2026) — REVERTIDA
Se intentó un mini-proxy local (`tigoTokenProxy.js`) que reescribía `wmsAuthSign` en cada request para evitar 403. Falló porque al refrescar el token el CDN devuelve **una sesión nueva con nombres de segmento nuevos**: FFmpeg seguía pidiendo segmentos viejos (`l_2104_1099099_181.ts`) y obtenía 404 en lugar de 403. La sesión Nimble es atómica: no se puede swappear `wmsAuthSign` sin swappear toda la lista de segmentos. El módulo se eliminó del repo.

## FASE 1 endurecida (Apr 2026, vigente) — Opción 3

**Arquitectura:**
```
FFmpeg (proxychains4 -q -f /tmp/proxychains-tigo.conf)
  → Pi5 SOCKS5 (200.91.131.146:1080)
  → Teletica CDN (cdn12.teletica.com)
```

### Variant Pinning manual
Antes de spawn, parseamos el master playlist via `fetchWithOptionalProxy(..., true)` y extraemos la URL de la variante 720p. Esa URL se inyecta como `inputSourceUrl` para que FFmpeg solo abra 1 video + 1 audio (no 4 variantes paralelas, lo que delata scraper).

### Flags FFmpeg endurecidos
- `-max_reload 50` (subido desde 8): tolerar más reintentos del demuxer HLS antes de matar.
- `-m3u8_hold_counters 50` (subido desde 10): aceptar más ciclos de "playlist sin nuevos segmentos" mientras el CDN rota la sesión.
- `-rtbufsize 512M`, `-thread_queue_size 16384`: absorber jitter del SOCKS5.
- `-fflags +genpts+discardcorrupt`, `-max_delay 5000000`: tolerancia a paquetes corruptos.
- `live_start_index` dinámico (-2 manual, -1 recovery).
- **SIN** `-http_persistent`, `-multiple_requests`, `-reconnect_*` (delatan scraper en Wowza/Nimble).

### Watchdog
- `stallTimeout = 120000ms` para Tigo (vs 75s scraped, 30s default): aguanta reloads de token (~60s) + jitter SOCKS5 sin matar prematuramente.
- `startTimeout = 45000ms` (compartido con scraped channels).

### User-Agent rotativo
Pool de 6 UAs reales en `REAL_USER_AGENTS`. `pickRandomUserAgent()` se llama por sesión: cada arranque/recovery = "cliente nuevo" para Wowza.

## proxychains4
El spawn de FFmpeg para Tigo se envuelve con `proxychains4 -q -f /tmp/proxychains-tigo.conf ffmpeg ...`. Config dinámica generada en `/tmp/proxychains-tigo.conf`.

## Anti doble-scrape
En `/api/emit`, si `is_recovery=true` Y `scrapeSessionCache` <10s → reusa la URL recibida (evita re-login redundante).

## Anti nimblesessionid heredado
**Quick Retry de Tigo**:
1. Delay 5s antes del retry (vs 500ms en otros procesos).
2. Cache-buster `&_t=<Date.now()>` al URL fresca antes de pasarla al `/api/emit`.

## Health-check del proxy SOCKS5
- `checkProxyHealth()`: TCP connect al puerto 1080, timeout 4s.
- Pre-spawn valida proxy. Si está caído → `failure_reason='proxy_down'`.

## Mensajes de fallo TIGO
`getFailureDescription` distingue `processIndex === 12`: `proxy_down`, `eof` (token 60s/microcorte/Teletica), default menciona proxy/token/Teletica/CDN.

## Shims residuales
`tigoProxies` Map y `stopTigoProxy()` quedaron como no-op en server.js para no romper llamadas remanentes en cleanup/exit handlers. No hay riesgo: el Map nunca se popula.

## Logs clave
- `🌊 Tigo VLC-like (Fase 1 endurecida): max_reload=50, hold=50, start -2`
- `📌 Tigo Variant Pinning → 1280x720 @ 2077kbps`
- `🎭 UA rotativo: Mozilla/5.0 ...`
- `🔧 Tigo/Teletica via Pi5: modo VLC-like (sin reconnect HTTP, solo demuxer HLS)`
