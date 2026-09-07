---
name: Perfil SD Pro 1100 (480p)
description: Perfil 'eco1100' 480p VBR 1100k pico 1600k AAC 96k, escalera tipo OTT; y sharp1800 pasa a preset fast
type: feature
---
`eco1100` "SD Pro 1100 (480p)" en OUTPUT_PROFILES (server.js) y dropdown de EmisorM3U8Panel.tsx:
- scale=-2:480, x264 preset fast, avg 1100k, maxrate 1600k, bufsize 3200k, AAC 96k
- x264-params: rc-lookahead=30:ref=3:bframes=3:b-adapt=1:aq-mode=3:aq-strength=1.1:psy-rd=1.0,0.10:mbtree=1:deblock=-1,-1
- Cadencia natural (isStandardProfile) igual que normal/highquality/sportspro/sharp1800
- ~45% menos ancho de banda que Normal 2000k; ~0.10 bits/píxel (rango SD de OTT)

Cambio en `sharp1800`: preset `medium` → `fast`, ref 5→3, b-adapt 2→1, lookahead 50→30, bufsize 5400k→4800k.
Motivo: los congelones venían de carga de CPU del encoder, no de la fuente.

DB: constraint `emission_processes_output_profile_check` incluye 'eco1100'.
