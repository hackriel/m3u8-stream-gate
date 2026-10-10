---
name: Canal 13 (pid 29) — Telecable dropdown
description: Tab Canal 13, Telecable-only con dropdown (default SINART13), salida HLS /live/canal13sinart/playlist.m3u8
type: feature
---
- pid 29, slug HLS `canal13sinart`, contentId por defecto `SINART13` (nombre "SINART" en Telecable).
- Telecable-only: sin toggle; dropdown de canales como Disney 7/8, el contentId viaja en `telecable_content_id`.
- Formato de salida elegible (incluye passthrough). Default normal.
- Disney 8 (pid 10, salida RTMP): Telecable SIN -re empujaba a ~3x y el RTMP destino cortaba a ~34s. Regla: toda salida RTMP usa -re.
