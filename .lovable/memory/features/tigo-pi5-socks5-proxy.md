---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica (microsocks Pi 5 con auth user/pass). Anti-jitter v3 (buffer 512M, start -2, max_delay 5s) ajustado para evitar 403 por token wmsAuthSign de 60s.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Anti-jitter v3 (estabilidad de fps + tolerancia a micro-stalls + compatible con token 60s)
Mitigaciones en input args para Tigo:
- `-http_persistent 1` + `-multiple_requests 1`: keep-alive HTTP sobre el proxy
- `-live_start_index -2`: arrancar 2 segmentos atrás (~12s buffer inicial)
  - **CRÍTICO**: v2 usaba -6 (~36s) pero causaba 403 Forbidden al chocar con la expiración del wmsAuthSign (60s). FFmpeg pedía segmentos viejos cuya URL ya estaba expirada, generando ~30s de errores 403 antes de que recargara el manifest.
- `-fflags +genpts+discardcorrupt`: regenerar PTS y descartar corruptos
- `-max_delay 5000000` (5s): tolerancia de reordenamiento de paquetes
- `-rtbufsize 512M` + `-thread_queue_size 16384`: absorber bursts de jitter del proxy residencial
- `-max_reload 1000` + `-m3u8_hold_counters 1000`: tolerancia HLS al máximo

Mantener `-re` (input flag) para pacing nativo. Salida CFR 29.97fps. Trade-off: ~12s de delay extra (no 36s como v2) a cambio de eliminar reloads leves simultáneos.

## Health-check del proxy (pre-spawn + monitoreo continuo)
- `checkProxyHealth()`: TCP connect simple al puerto 1080, timeout 4s.
- Monitor pasivo cada 60s (~50 bytes/min, despreciable). Mantiene historial de 30 muestras.
- Pre-spawn: antes de lanzar FFmpeg con proxychains, se valida proxy. Si está caído, marca `failure_reason='proxy_down'` con mensaje claro y no spawnea.
- Endpoint `/api/proxy-status` expone latencia actual, promedio, uptime % y último error al frontend.

## Hardware stats Pi5 (DESCARTADO)
Se intentó exponer CPU/RAM/temp del Pi5 vía mini-servicio HTTP en puerto 8080, pero el router residencial CR solo tiene port-forwarding del 1080 (SOCKS5). Tocar la configuración del router no se justifica para esto. **No volver a proponerlo.**

## Mensajes de fallo TIGO en UI
`getFailureDescription` distingue cuando `processIndex === 12`:
- `proxy_down`: explica posibles causas (corte eléctrico, Wi-Fi, microsocks, IP residencial cambió).
- `eof`: en TIGO menciona token wmsAuthSign 60s, microcorte del proxy, o sesión cortada por Teletica.
- Default en TIGO menciona explícitamente proxy/token/Teletica/CDN.
