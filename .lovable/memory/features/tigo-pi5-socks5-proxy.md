---
name: tigo-pi5-socks5-proxy
description: Proceso ID 12 (TIGO URL) enruta scraping y FFmpeg vía proxy SOCKS5 residencial Costa Rica (microsocks Pi 5 con auth user/pass). Incluye anti-jitter HTTP keep-alive para estabilizar fps.
type: feature
---

El proceso ID 12 (TIGO URL) usa el proxy SOCKS5 residencial de Costa Rica:
`socks5h://cr_proxy_srv:CrProxy2026pR7x9dL4@200.91.131.146:1080` (microsocks en Pi 5).

Configurado en server.js como `TIGO_PROXY_URL` y leído desde la variable de entorno del mismo nombre en systemd.

Tanto el scraping (login + token via Edge Function `scrape-channel-proxy` o `/api/local-scrape`) como FFmpeg (envuelto en `proxychains4 -q -f /tmp/proxychains-tigo.conf`) salen por la IP residencial CR para que el `wmsAuthSign` token de Teletica (60s de validez) quede vinculado a la misma IP que consume el stream.

## Anti-jitter (crítico para estabilidad de fps)

El proxy SOCKS5 residencial introduce jitter (50-300ms por segmento .ts), causando que `-re` haga oscilar fps entre 24-30. Mitigaciones aplicadas en input args:
- `-http_persistent 1` + `-multiple_requests 1`: reusar conexión HTTP keep-alive sobre el proxy (evita renegociar SOCKS5+TLS por cada .ts)
- `-live_start_index -4`: arrancar 4 segmentos atrás para tener buffer
- `-fflags +genpts+discardcorrupt`: regenerar PTS y descartar paquetes corruptos
- `-rtbufsize 256M` + `-thread_queue_size 8192`: absorber bursts de jitter
- `-max_reload 1000` + `-m3u8_hold_counters 1000`: tolerancia HLS al máximo

Mantener `-re` (input flag) para pacing nativo. Salida sigue CFR 29.97fps.
