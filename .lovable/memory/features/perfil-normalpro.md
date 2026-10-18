---
name: Perfil Normal Mejorado Pro (normalpro)
description: 720p CBR 2000k fijo (sin picos) con preset fast, lookahead 40, aq-mode 3 y denoise hqdn3d — misma red que Normal, mejor imagen por bit
type: feature
---
Perfil `normalpro` ("Normal Mejorado Pro") en OUTPUT_PROFILES (server.js) y dropdown de EmisorM3U8Panel.tsx.

Regla del usuario: NUNCA generar picos de bitrate hacia clientes/XUI — maxrate = bitrate = 2000k, bufsize 4000k (2s). La mejora es solo calidad por bit:
- preset `fast` (no veryfast; NO subir a medium — los presets lentos causaron congelones en vivo).
- x264Params: rc-lookahead=40:ref=4:bframes=3:aq-mode=3:aq-strength=1.1:me=umh:subme=8:scenecut=0 (GOP fijo 2s).
- `denoise: 'hqdn3d=1.5:1.5:6:6'` — nuevo campo opcional de perfil; se concatena al `-vf` tras el scale en los 4 caminos de encode (principal, SRT stage, SRT output, re-encode >5000kbps).
- audioRate 48000 + `-ac 2` (sin resampleo), threads 6.
- Sin forceCfr → cadencia natural en HLS scrapeado (isStandardProfile).

Constraint DB `emission_processes_output_profile_check` incluye 'normalpro' (migración 0001_add_normalpro_output_profile).
