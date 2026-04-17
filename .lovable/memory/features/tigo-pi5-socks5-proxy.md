---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica (microsocks Pi 5 con auth user/pass). Anti-jitter v2 (buffer 512M, start -6, max_delay 5s), health-check pre-spawn, monitoreo continuo del proxy y stats hardware Pi5 (CPU/RAM/temp).
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Anti-jitter v2 (estabilidad de fps + tolerancia a micro-stalls del proxy)
Mitigaciones en input args para Tigo:
- `-http_persistent 1` + `-multiple_requests 1`: keep-alive HTTP sobre el proxy
- `-live_start_index -6`: arrancar 6 segmentos atrás (~36s buffer inicial)
- `-fflags +genpts+discardcorrupt`: regenerar PTS y descartar corruptos
- `-max_delay 5000000` (5s): tolerancia de reordenamiento de paquetes
- `-rtbufsize 512M` + `-thread_queue_size 16384`: absorber bursts de jitter del proxy residencial
- `-max_reload 1000` + `-m3u8_hold_counters 1000`: tolerancia HLS al máximo

Mantener `-re` (input flag) para pacing nativo. Salida CFR 29.97fps. Trade-off: ~30s de delay extra a cambio de eliminar reloads leves simultáneos en clientes.

## Health-check del proxy (pre-spawn + monitoreo continuo)
- `checkProxyHealth()`: TCP connect simple al puerto 1080, timeout 4s.
- Monitor pasivo cada 60s (~50 bytes/min, despreciable). Mantiene historial de 30 muestras.
- Pre-spawn: antes de lanzar FFmpeg con proxychains, se valida proxy. Si está caído, marca `failure_reason='proxy_down'` con mensaje claro y no spawnea.

## Stats hardware del Pi5 (CPU/RAM/temp/load)
- Mini-servicio Python en el Pi5 (`scripts/pi5-stats.py`) escucha en `:8080/stats`, sin dependencias externas.
- Servicio systemd `pi5-stats.service` corre como user `ariel`, restart=always.
- VPS hace polling HTTP cada 60s (~80 bytes JSON, ~5KB/hora — despreciable).
- Variable env `PI5_STATS_URL` (default `http://200.91.131.146:8080/stats`).
- Estado en `pi5StatsState`: cpuPct, ramPct, ramUsedMb, ramTotalMb, tempC, loadAvg1, uptimeSec.
- Endpoint `/api/proxy-status` devuelve `pi5: {...}` además del estado del proxy.
- Frontend: widget `ProxyHealthBadge` muestra dos secciones (Proxy + Hardware Pi5) con thresholds:
  - CPU: verde <65%, amarillo 65-85%, rojo >85%
  - RAM: verde <70%, amarillo 70-85%, rojo >85%
  - Temp: verde <65°C, amarillo 65-75°C, rojo >75°C (throttling Pi5 a 80°C)
- Si el Pi5 no tiene el script corriendo, la sección hardware muestra instrucciones de instalación.

## Mensajes de fallo TIGO en UI
`getFailureDescription` distingue cuando `processIndex === 12`:
- `proxy_down`: explica posibles causas (corte eléctrico, Wi-Fi, microsocks, IP residencial cambió).
- `eof`: en TIGO menciona token wmsAuthSign 60s, microcorte del proxy, o sesión cortada por Teletica.
- Default en TIGO menciona explícitamente proxy/token/Teletica/CDN.
