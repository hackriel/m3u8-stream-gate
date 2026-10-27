---
name: Escalera de perfiles OTT vigente
description: Perfiles de salida vigentes tras retirar sd480 y mid576 (se pegaban en producción, Oct 2026)
type: feature
---
Perfiles ÚNICOS en OUTPUT_PROFILES (server.js) y dropdown de EmisorM3U8Panel.tsx:
- passthrough (copy)
- highquality: 720p CBR 4000k, AAC 192k, preset faster, threads 6
- hd720: 720p 3000k avg / 3600k pico / bufsize 6000k, AAC 128k, preset faster, threads 6
- normal: 720p CBR 2000k, AAC 128k, preset veryfast
- normalpro: 720p CBR 2000k fijo (sin picos), preset fast, lookahead 40, aq-mode 3, denoise hqdn3d, AAC 128k 48kHz

RETIRADOS (Oct 2026, decisión del usuario: "se pegaban, no fueron efectivos"):
- sd480 (480p 1500k) y mid576 (576p 1800k) eliminados de OUTPUT_PROFILES, UI y constraint DB.
- LEGACY_PROFILE_ALIASES los remapea: sd480→normal, mid576→normalpro (también sharp1800/balanced→normalpro, eco1100/optimized/sports1500→normal).

REGLA: nunca usar presets slow/medium en vivo — los congelones venían del preset lento, no de la fuente. Todo `faster` o más rápido (normalpro usa `fast`, validado por el usuario).
Cadencia natural (isStandardProfile) para highquality/normal/normalpro/hd720 sobre HLS scrapeado.
Constraint DB: passthrough|highquality|hd720|normal|normalpro (migración 0002_remove_sd480_mid576_profiles).
Dispositivos de los clientes: Android TV, Samsung Tizen/webOS, iPhone, Android, Fire Stick, Roku → H.264 obligatorio (HEVC riesgoso en Fire Stick/Roku viejos y XUI).
