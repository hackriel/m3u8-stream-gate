---
name: Cadencia natural vs CFR forzado
description: Alta Calidad y Normal salen con cadencia natural de la fuente HLS; Deportes 1800/1500, SRT, RTMP y passthrough van a 30fps CFR forzado
type: feature
---
Regla en server.js (`isNaturalCadence`):
- Perfiles `highquality`, `normal`, `hd720` y `mid576` sobre fuentes HTTP/HLS scrapeadas → `-vsync passthrough`, sin `-r`. Elimina DUP/DROP cosméticos.
- Perfil `sd480` (forceCfr): CFR al fps detectado por ffprobe, nunca cadencia natural.
- SRT ingest, RTMP, Tigo HDMI y passthrough → siempre cadencia forzada/copy.
- Canal 6 URL (15): el filtro `fps=30` solo se aplica cuando NO está en cadencia natural.
GOP sigue calculado por ffprobe (2 segundos).
