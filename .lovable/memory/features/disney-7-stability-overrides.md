---
name: Disney 7 Overrides (IDs 0 y 16)
description: ID 0 (M3U passthrough) usa perfil VLC-like; ID 16 (SRT desde OBS) usa bitrate elevado para fútbol
type: feature
---
# Disney 7 Overrides

## ID 0 — M3U passthrough
Perfil VLC-like (ver memoria original) para sources DRM-light.

## ID 16 — SRT ingest desde OBS (deportes/fútbol)
ETAPA 2 (transcode buffer→HLS) usa parámetros elevados vs el perfil unificado:
- `-b:v 3500k` / `-maxrate 3500k` (vs 2000k estándar)
- `-bufsize 7000k` (vs 4000k)
- `-preset faster` (vs veryfast)

Razón: contenido deportivo (fútbol) con panorámicas y movimiento rápido se rompía en bloques con 2000k/veryfast. 3500k es el sweet spot para 720p30 deportes; preset faster mejora calidad por bit sin saturar CPU.

Implementado en server.js dentro del bloque `spawnSrtOutputStage` mediante flag `isDisney7 = process_id === '16'`. El resto de canales SRT (12, 18) siguen con 2000k/veryfast.
