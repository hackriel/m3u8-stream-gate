---
name: TDMax Fast-404 reactivo
description: Detección de token/URL muerta leyendo el stderr de FFmpeg en pids 11/13/14/24/25; prohibido sondear la URL periódicamente
type: feature
---

En `server.js`, dentro del handler `ffmpegProcess.stderr`. `TDMAX_FAST_404_PROCESSES = {11, 13, 14, 24, 25}`
(FUTV URL, TELETICA URL, TDMAS 1 URL, FOX+ URL, FOX URL).

Regla: 2 "Failed to reload playlist" en ≤5s → SIGTERM (+SIGKILL 2s), invalida
`scrapeSessionCache` y `lastKnownStreamState` → la auto-recovery hace scrape fresco.
También existe el detector de "Failed to open segment" (25 fails + frame congelado 8s)
para fragmentos perdidos.

**Constraint del usuario:** NO hacer polling/sondeo periódico de la URL de la fuente
(se implementó un probe cada 15s y fue rechazado). Motivo: genera ruido/consumo
innecesario y riesgo sobre el token/sesión. Toda detección debe ser reactiva a lo que
FFmpeg ya reporta. Si la fuente camina bien, no se la toca.
