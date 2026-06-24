---
name: Canal 8 / Canal 2 — Telecable-only
description: Nuevos pids 27/28 (Canal 8 URL MULTIMEDIOS, Canal 2 URL CDR), forzados a modo Telecable sin toggle.
type: feature
---
IDs:
- 27 → Canal 8 URL, contentId `MULTIMEDIOS`, slug HLS `Canal8`.
- 28 → Canal 2 URL, contentId `CDR`, slug HLS `Canal2`.

Ambos están en TELECABLE_PROCESSES y TELECABLE_CHANNEL_MATCHERS. La UI los
marca como `TELECABLE_ONLY_PIDS`: oculta el toggle "Fuente alterna" y reusa
el botón "📡 Scrapear Telecable" para resolver la URL HLS firmada vía
`POST /api/telecable/:pid/refresh`. URL para compartir:
`http://167.17.69.116:3001/live/Canal8/playlist.m3u8` y
`http://167.17.69.116:3001/live/Canal2/playlist.m3u8`.