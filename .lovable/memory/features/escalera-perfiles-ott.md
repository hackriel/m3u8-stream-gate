---
name: Escalera de perfiles OTT (HD720 / Mid576 / SD480)
description: Perfiles de salida vigentes tras eliminar sportspro, sharp1800, eco1100, sports1800, sports1500, balanced y optimized
type: feature
---
Perfiles ÚNICOS en OUTPUT_PROFILES (server.js) y dropdown de EmisorM3U8Panel.tsx:
- passthrough (copy)
- highquality: 720p CBR 4000k, AAC 192k, preset faster, threads 6
- hd720: 720p 3000k avg / 3600k pico / bufsize 6000k, AAC 128k, preset faster, threads 6
- normal: 720p CBR 2000k, AAC 128k, preset veryfast
- mid576: 576p 2350k avg / 2800k pico / bufsize 4700k, AAC 128k, preset faster, threads 6
- sd480: 480p 1500k avg / 2100k pico / bufsize 3000k, AAC 96k, preset faster, threads 4

Bitrates tomados de la escalera pública YouTube live 720p30 (3000k) y Netflix (1750/2350/3000).
REGLA: nunca usar presets fast/medium en vivo — los congelones de sportspro/sharp1800 venían del preset lento, no de la fuente. Todo `faster` o más rápido.
Cadencia natural (isStandardProfile) para highquality/normal/hd720/mid576/sd480 sobre HLS scrapeado.
Perfiles viejos se remapean vía LEGACY_PROFILE_ALIASES. Constraint DB: passthrough|highquality|hd720|normal|mid576|sd480.
