---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica (microsocks Pi 5 con auth user/pass). Anti-jitter v3 (buffer 512M, start -2/-1, max_delay 5s). Optimización anti doble-scrape: si Quick Retry ya scrapeó hace <10s, /api/emit reusa la URL fresca. live_start_index dinámico: -2 manual, -1 en recovery. Quick Retry de Tigo espera 5s + cache-buster en URL para liberar nimblesessionid de Wowza.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Tecnología del CDN
Teletica usa **Wowza Streaming Engine + Nimble Streamer** con autenticación `wmsAuthSign` y un `nimblesessionid` por sesión. El token `wmsAuthSign` se valida en CADA segmento (no solo al conectar).

## Anti-jitter v3
- `-http_persistent 1` + `-multiple_requests 1`: keep-alive HTTP sobre el proxy
- `-live_start_index` **dinámico**: `-2` manual (~12s), `-1` recovery (~6s, más cerca del vivo).
- `-fflags +genpts+discardcorrupt`, `-max_delay 5000000` (5s)
- `-rtbufsize 512M` + `-thread_queue_size 16384`
- `-max_reload 1000` + `-m3u8_hold_counters 1000`
- Mantener `-re` (input flag). Salida CFR 29.97fps.

## Anti doble-scrape
En `/api/emit`, si `is_recovery=true` Y `scrapeSessionCache` <10s, se reusa la URL recibida y se salta el refresh JIT. Log: `♻️ Reusando URL fresca del Quick Retry (scrapeada hace Ns) — sin doble scrape`.

## Anti nimblesessionid heredado (CRÍTICO, Apr 2026)
**Problema observado**: tras una caída por token expirado, el Quick Retry inmediato (~500ms) refrescaba la URL via Pi5 pero FFmpeg recibía 403 en TODOS los segmentos durante ~30-40s antes de morir. Causa: el master `playlist.m3u8` devolvía sub-playlists (`chunks.m3u8`) con el `nimblesessionid=XXXX` de la sesión anterior, que Wowza ya había invalidado al expirar el `wmsAuthSign` original. Aunque el nuevo `wmsAuthSign` era válido, el `nimblesessionid` muerto causaba 403.

**Solución doble** (solo para `PROXY_PROCESSES`):
1. **Delay 5s** antes del Quick Retry (vs 500ms en el resto). Da tiempo a Wowza para liberar el estado de la sesión Nimble anterior.
2. **Cache-buster**: se agrega `&_t=<Date.now()>` al URL fresca antes de pasarla a FFmpeg, forzando a Wowza a tratar el request del master playlist como nuevo y asignar un `nimblesessionid` limpio. Log: `✅ RETRY: URL fresca obtenida via Pi5 (con cache-buster anti nimblesessionid)`.

Localización: `setTimeout` del Quick Retry en server.js (cerca línea 2215) y refresh URL post-scrape (cerca línea 2263).

## Health-check del proxy
- `checkProxyHealth()`: TCP connect al puerto 1080, timeout 4s.
- Monitor pasivo cada 60s. Pre-spawn valida proxy; si está caído marca `failure_reason='proxy_down'`.
- `/api/proxy-status` expone latencia/uptime al frontend.

## Hardware stats Pi5 (DESCARTADO)
Router residencial CR solo tiene port-forwarding del 1080. **No volver a proponerlo.**

## Mensajes de fallo TIGO
`getFailureDescription` distingue `processIndex === 12`: `proxy_down`, `eof` (token 60s/microcorte/Teletica), default menciona proxy/token/Teletica/CDN.
