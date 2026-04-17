---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica (microsocks Pi 5 con auth user/pass). Incluye anti-jitter HTTP keep-alive, health-check pre-spawn y monitoreo continuo del proxy.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Anti-jitter (estabilidad de fps)
Mitigaciones en input args para Tigo:
- `-http_persistent 1` + `-multiple_requests 1`: keep-alive HTTP sobre el proxy
- `-live_start_index -4`: arrancar 4 segmentos atrás (buffer)
- `-fflags +genpts+discardcorrupt`: regenerar PTS y descartar corruptos
- `-rtbufsize 256M` + `-thread_queue_size 8192`: absorber bursts de jitter
- `-max_reload 1000` + `-m3u8_hold_counters 1000`: tolerancia HLS al máximo

Mantener `-re` (input flag) para pacing nativo. Salida CFR 29.97fps.

## Health-check del proxy (pre-spawn + monitoreo continuo)
- `checkProxyHealth()`: TCP connect simple al puerto 1080, timeout 4s.
- Monitor pasivo cada 60s (~50 bytes/min, despreciable). Mantiene historial de 30 muestras.
- Pre-spawn: antes de lanzar FFmpeg con proxychains, se valida proxy. Si está caído, marca `failure_reason='proxy_down'` con mensaje claro y no spawnea.
- Endpoint público `/api/proxy-status` devuelve: reachable, latencyMs, avgLatencyMs, uptimePct, lastError, ageSeconds.
- Frontend: `useProxyStatus` hook + `ProxyHealthBadge` componente, renderizado solo en el tab de TIGO URL. Muestra verde (<400ms), amarillo (>400ms), rojo (caído).

## Mensajes de fallo TIGO en UI
`getFailureDescription` distingue cuando `processIndex === 12`:
- `proxy_down`: explica posibles causas (corte eléctrico, Wi-Fi, microsocks, IP residencial cambió).
- `eof`: en TIGO menciona token wmsAuthSign 60s, microcorte del proxy, o sesión cortada por Teletica.
- Default en TIGO menciona explícitamente proxy/token/Teletica/CDN.
