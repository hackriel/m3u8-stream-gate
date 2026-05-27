---
name: Teletica SRT ingest (ID 21)
description: Pi5 ejecuta TDMax login local y empuja Teletica vía SRT caller al VPS:9004; mutex con TELETICA URL (13)
type: feature
---
# Teletica SRT (ID 21)

- Slug HLS `Teletica` (compartido con ID 13 TELETICA URL → mutuamente excluyentes en el panel y en `/live/Teletica/playlist.m3u8`).
- Puerto SRT VPS: **9004** (`TELETICA_SRT_PORT`).
- Listener arrancado por server.js cuando el switch del tab está ON; cuando está OFF, el Pi5 caller falla suave y reintenta.
- Pi5 hace su propio login a TDMax (no usa edge function ni `/api/local-scrape`) para que el token quede IP-locked al Pi5, que es el mismo IP desde el que ffmpeg lee los segments.
- Debe usar `DEVICE_ID` TDMax exclusivo para Teletica; no compartir el mismo device-id con FOX+/FOX en la misma cuenta Pi5 porque un login de otro canal puede invalidar/rotar la sesión y cortar la señal.
- Refresh proactivo cada 8 min (token TDMax ≈ 10 min).
- Código y systemd unit en `pi5-teletica-srt/` (instala con `sudo bash install.sh`).
- Migración subió `emission_processes_id_check` a `id <= 30` para permitir ID 21.