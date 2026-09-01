---
name: Perfil de salida Alta Calidad
description: Perfil 'highquality' 720p CBR 4000k AAC 192k disponible en el dropdown de todos los canales
type: feature
---

Perfil `highquality` ("Alta Calidad") en `OUTPUT_PROFILES` (server.js) y en el dropdown "Formato de salida" de `EmisorM3U8Panel.tsx`.

Parámetros:
- 720p (`scale=-2:720`), libx264 CBR 4000k, bufsize 8000k, maxrate 4000k
- preset `faster`, `-profile:v main`, GOP 2s (59.94), sc_threshold 0
- x264-params: `rc-lookahead=30:ref=3:bframes=2`
- AAC 192k

Disponible en TODOS los canales (decisión del usuario, para no dejar nada por fuera).

Ganancia real solo cuando la fuente llega ≥3 Mbps: SRT/OBS (16/18/20/21/22/23), FOX+ (24), FOX (25), Teletica (4), Canal 6 (5), Disney 8 (10).
Sin ganancia (fuente por debajo): Disney 7 (0), Canal 8/Canal 2 Telecable (27/28), canales scrapeados de baja tasa.

Costo: ~2x CPU y ~2x egress vs Normal.

DB: constraint `emission_processes_output_profile_check` incluye 'highquality'.
