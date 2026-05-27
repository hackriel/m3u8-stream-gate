---
name: FOX+ / FOX SRT ingest (IDs 22 y 23)
description: Pi5 hace login TDMax con cuenta info@media.cr y empuja FOX+ y FOX vía SRT caller al VPS (9005/9006)
type: feature
---
# FOX+ SRT (ID 22) y FOX SRT (ID 23)

- Slugs HLS: `foxmas` y `fox` → `/live/foxmas/playlist.m3u8`, `/live/fox/playlist.m3u8`.
- Puertos SRT en VPS: 9005 (FOX+) y 9006 (FOX). Env opcionales: `FOXMAS_SRT_PORT`, `FOX_SRT_PORT`.
- Cuenta TDMax dedicada Pi5: `info@media.cr`. Actualmente enfocarse sólo en FOX+ y FOX desde Raspberry; no mezclar decisiones con Teletica.
- TDMax channel IDs:
  - FOX+ : `6a10a6a2350cb5151ab6ca8c`
  - FOX  : `664237788f085ac1f2a15f81`
- Cada pusher Pi5 debe usar un `DEVICE_ID` TDMax distinto por canal; no compartir el mismo device-id entre Teletica/FOX+/FOX porque los logins con la cuenta `info@media.cr` pueden invalidar sesiones entre sí y causar cortes/reconexiones en menos de 1 hora.
- Código: `pi5-foxmas-srt/` y `pi5-fox-srt/` (clones de `pi5-teletica-srt/`). Mismos refreshes 00:00 y 05:00 CR.
- Arquitectura robusta 2026 para Pi5: una sola sesión TDMax por canal, FFmpeg Stage A lee TDMax HLS y envía MPEG-TS a UDP local; Stage B `srt-live-transmit` mantiene el caller SRT al VPS. No usar doble sesión/reproductor para “estabilidad”.
- Puertos: FOX+ SRT 9005 con UDP local 10005; FOX SRT 9006 con UDP local 10006. No confundir con Teletica 9004.
- Servicios independientes: `foxmas-srt-pusher.service` y `fox-srt-pusher.service`. Arranque escalonado recomendado: FOX+ primero, FOX ~20s después.
