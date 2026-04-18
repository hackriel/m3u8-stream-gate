---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica (microsocks Pi 5 con auth user/pass). Anti-jitter v3 (buffer 512M, start -2/-1, max_delay 5s). Optimización anti doble-scrape: si Quick Retry ya scrapeó hace <10s, /api/emit reusa la URL fresca. live_start_index dinámico: -2 manual, -1 en recovery.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Anti-jitter v3 (estabilidad de fps + tolerancia a micro-stalls + compatible con token 60s)
Mitigaciones en input args para Tigo:
- `-http_persistent 1` + `-multiple_requests 1`: keep-alive HTTP sobre el proxy
- `-live_start_index` **dinámico** (optimización Apr 2026):
  - **Arranque manual**: `-2` (~12s buffer) → margen ante jitter inicial.
  - **Recovery (`is_recovery=true`)**: `-1` (~6s buffer) → arrancar más cerca del vivo
    para evitar pedir segmentos al borde de expiración del wmsAuthSign cuando la URL
    ya viene fresca del scraping. Reduce sesiones cortas (~30-60s) tras recovery.
  - **CRÍTICO**: v2 usaba `-6` (~36s) pero causaba 403 Forbidden al chocar con la expiración del wmsAuthSign (60s). Con `-2`/`-1` hay margen para jitter pero arranca cerca del vivo.
- `-fflags +genpts+discardcorrupt`: regenerar PTS y descartar corruptos
- `-max_delay 5000000` (5s): tolerancia de reordenamiento de paquetes
- `-rtbufsize 512M` + `-thread_queue_size 16384`: absorber bursts de jitter del proxy residencial
- `-max_reload 1000` + `-m3u8_hold_counters 1000`: tolerancia HLS al máximo

Mantener `-re` (input flag) para pacing nativo. Salida CFR 29.97fps.

## Anti doble-scrape (optimización Apr 2026)
**Problema detectado**: el Quick Retry scrapea via Pi5 (línea ~2237) y luego llama `/api/emit`,
que en línea ~1316 **volvía a scrapear** → dos sesiones simultáneas en Streann en <3s,
posible desincronización del token con la conexión TCP de FFmpeg, sesiones cortas (~37s).

**Solución**: en `/api/emit`, si el caller marca `is_recovery=true` Y el `scrapeSessionCache`
tiene timestamp <10s, se reusa la URL recibida y se salta el refresh JIT. Log distintivo:
`♻️ Reusando URL fresca del Quick Retry (scrapeada hace Ns) — sin doble scrape`.

Para arranques manuales o recoveries con caché vieja, el refresh JIT sigue activo (necesario
porque el wmsAuthSign expira en 60s).

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
