---
name: Contador y detalle de visores
description: Badge con ojo + número de visores en /uptime y "Señales activas"; al hacer clic abre detalle con IP, geo/ISP y tipo de cliente vía /api/viewers/details
type: feature
---
- `server.js` registra cada request a `/live/<slug>/*.m3u8|*.ts` (y `/canal6.ts`) como visor: clave `IP|user-agent`, guardando `{ip, ua, firstSeen, lastSeen, hits, lastPath}`.
- Un visor cuenta si fue visto en los últimos `VIEWER_TTL_MS` (default 45000).
- `GET /api/viewers` → `{ by_slug, by_pid, total, ttl_ms }`; `by_pid` usa `HLS_SLUG_MAP`.
- `GET /api/viewers/details?pid=<id>` (o `?slug=`) → lista de visores con IP, user-agent, hits, tiempo conectado y `info` geo/ASN (ip-api.com, cache 24h, flags proxy/hosting/mobile).
- El ojo es un botón: abre `ViewerDetailsDialog` (compartido por `/uptime` y `EmisorM3U8Panel`), refresca cada 10s e infiere el cliente (FFmpeg/XUI = posible re-stream, VLC, ExoPlayer, navegador, etc.).
- Fuera del VPS muestra `—` y el diálogo avisa que el detalle solo existe en el servidor.
