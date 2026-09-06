---
name: TDMax Source Health Probe
description: Vigía read-only de la fuente TDMax (pids 11/13/14/24/25) que adelanta el recovery ante 403/404/ENDLIST o MEDIA-SEQUENCE congelado
type: feature
---

En `server.js`, tras el watchdog. Cada `SOURCE_PROBE_INTERVAL_MS` (15s) hace un GET
read-only a la MISMA sub-playlist que lee FFmpeg, con headers TDMax
(UA web + Referer/Origin app.tdmax.com). NO hace login extra → no puede
invalidar la sesión en curso.

Acciona recovery anticipado (SIGKILL + scrape fresco) cuando:
- HTTP 403/404/410 (token wmsAuthSign vencido / sesión muerta)
- `#EXT-X-ENDLIST` (el origen cerró el live)
- `#EXT-X-MEDIA-SEQUENCE` congelado > `SOURCE_PROBE_FREEZE_MS` (45s) → problema del origen TDMax

Errores de red aislados solo se loguean (no matan la emisión).
Cooldown 90s, no arranca antes de 40s de emisión, se salta pids en modo Telecable.
Desactivable con `SOURCE_PROBE=0`. Estado consultable en `GET /api/source-health`.

Beneficio: reduce el corte de aire de ~75s (watchdog scraped) a ~15-20s.
