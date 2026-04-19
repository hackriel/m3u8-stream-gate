---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) usa Pi5 SOCKS5 + Fase 1 endurecida (proxychains4 → CDN) + Opción 1 BUFFER HLS LOCAL de 2 etapas (FFmpeg #1 ingest crudo -c copy a /tmp/tigo-buffer-12, FFmpeg #2 transcoder local 720p CBR 2000k → /live/Tigo/playlist.m3u8). Reversible con env TIGO_USE_BUFFER=false. Mantiene keepalive playlist 25s + logging quirúrgico de micro-cortes. Variant Pinning manual a 720p, max_reload=50, m3u8_hold_counters=50, watchdog stall 120s. Fase 2 (mini-proxy con token refresher) fue probada y revertida — incompatible con nimblesessionid de Wowza.
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

## OPCIÓN 1 — BUFFER HLS LOCAL DE 2 ETAPAS (Apr 2026, vigente)

**Arquitectura:**
```
[ETAPA 1 — INGEST]
FFmpeg #1 (proxychains4 → Pi5 SOCKS5 → Teletica CDN)
  → -c copy (sin transcode)
  → /tmp/tigo-buffer-12/buf.m3u8 (8s seg × 6 = ~48s buffer)

[ETAPA 2 — OUTPUT]
FFmpeg #2 (-re, lee disco local, NO toca CDN)
  → transcode 720p CBR 2000k AAC 128k
  → /dev-server/live/Tigo/playlist.m3u8 (lo que consume el TV)
```

### Por qué resuelve los micro-cortes
Los micro-cortes de 2-3s en TV venían de gaps cortos del CDN (rotación nimblesessionid, jitter SOCKS5, token expirado entre segmentos). Con el buffer, FFmpeg #2 lee siempre del disco local que tiene ~48s de colchón. Solo si Tigo cae >24-30s seguidos el TV nota algo. Recoveries de #1 son invisibles porque #2 sigue alimentando del buffer.

### Por qué NO aumenta el riesgo de baneo
- FFmpeg #1 sigue siendo **un único cliente HLS** con la misma cadencia que antes (~6s entre polls al playlist).
- FFmpeg #2 lee **disco local**, cero tráfico al CDN.
- Sin lecturas paralelas, sin token swap, sin rotación agresiva (eso era Fase 2).

### Costo
- Latencia añadida: +3-5s (TV se siente "tarde" vs cable).
- CPU extra: +15-20% por canal (despreciable en VPS de 36 vCPUs).
- Disco I/O: ~5MB/s en `/tmp` (despreciable en SSD).

### Reversibilidad
Variable de entorno `TIGO_USE_BUFFER` (default `true`). Si se setea a `false` en systemd, Tigo vuelve al modo single-FFmpeg de la Fase 1 endurecida sin tocar código.

### Componentes en server.js
- `TIGO_BUFFER_DIR = '/tmp/tigo-buffer-12'`
- `TIGO_BUFFER_PLAYLIST = '/tmp/tigo-buffer-12/buf.m3u8'`
- `TIGO_BUFFER_MIN_SEGMENTS = 3` (espera antes de spawnear ETAPA 2)
- `cleanTigoBufferDir()`, `waitForTigoBufferReady()`, `stopTigoOutputStage()`
- Map `tigoOutputProcesses` para rastrear FFmpeg #2.
- `useTigoBuffer = isHlsOutput && process_id === '12' && TIGO_USE_BUFFER && isProxyScrapedSource`
- ETAPA 2 se auto-reinicia si cae mientras ETAPA 1 sigue viva (solo reintento local, sin tocar CDN).
- `close` handler de FFmpeg #1 llama `stopTigoOutputStage()` para matar ETAPA 2 antes de recovery.

## FASE 1 endurecida (Apr 2026) — base de la ETAPA 1

### Variant Pinning manual
Antes de spawn, parseamos el master playlist via `fetchWithOptionalProxy(..., true)` y extraemos la URL de la variante 720p. Esa URL se inyecta como `inputSourceUrl`.

### Flags FFmpeg endurecidos (ETAPA 1)
- `-max_reload 50`, `-m3u8_hold_counters 50`
- `-rtbufsize 512M`, `-thread_queue_size 16384`
- `-fflags +genpts+discardcorrupt`, `-max_delay 5000000`
- `live_start_index` dinámico (-2 manual, -1 recovery).
- **SIN** `-http_persistent`, `-multiple_requests`, `-reconnect_*`.

### Watchdog
- `stallTimeout = 120000ms` para Tigo, `startTimeout = 45000ms`.

### User-Agent rotativo
Pool de 6 UAs reales en `REAL_USER_AGENTS`, `pickRandomUserAgent()` por sesión.

## proxychains4
ETAPA 1 se envuelve con `proxychains4 -q -f /tmp/proxychains-tigo.conf ffmpeg ...`. Config dinámica generada en `/tmp/proxychains-tigo.conf`. ETAPA 2 NO usa proxychains (lee disco local).

## Keep-alive playlist (Opción B)
Sigue activo: GET cada 25s vía Pi5 al playlist para mantener `nimblesessionid` caliente. Complementa al buffer.

## Anti doble-scrape
En `/api/emit`, si `is_recovery=true` Y `scrapeSessionCache` <10s → reusa la URL recibida.

## Anti nimblesessionid heredado
Quick Retry de Tigo: delay 5s + cache-buster `&_t=<Date.now()>`.

## Health-check del proxy SOCKS5
`checkProxyHealth()`: TCP connect al puerto 1080, timeout 4s. Pre-spawn valida proxy.

## Logs clave
- `🌊 Tigo BUFFER ETAPA 1 → /tmp/tigo-buffer-12/buf.m3u8 (-c copy, 8s seg × 6)`
- `⏳ Tigo BUFFER ETAPA 2: esperando ≥3 segmentos en buffer...`
- `✅ Tigo BUFFER listo (N segs en Mms) — spawneando ETAPA 2`
- `🎬 Tigo BUFFER ETAPA 2 → /live/Tigo/playlist.m3u8 (transcode local 720p CBR 2000k)`
- `🔁 Tigo BUFFER ETAPA 2 cayó (code=N) — reiniciando en 2s (ETAPA 1 sigue viva)`
- `💓 KeepAlive playlist activado (cada 25s vía Pi5)`
- `🔄/🔑/📋/⚠️/🌐` clasificación de micro-cortes en stderr de ETAPA 1.
