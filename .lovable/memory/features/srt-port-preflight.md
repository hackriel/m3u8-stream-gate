---
name: SRT port preflight (anti-zombi)
description: Antes de spawn del SRT listener, libera el puerto UDP si hay ffmpeg/srt-live-transmit huérfanos atados al bind
type: feature
---
Función `ensureSrtPortFree(port, process_id, label)` en server.js corre antes de `startSrtIngest` (IDs 21/22/23 → 9004/9005/9006) y `startTigoHdmiIngest` (TIGO_SRT_PORT). Usa `lsof -tiUDP:<port>`; si el PID está en `ffmpeg|srt-live-transmit` lo mata con SIGKILL y duerme 500ms. Si es un proceso ajeno (otro servicio), loguea error y NO mata. Soluciona "Input/output error" en :PORT a los 2s tras kill abrupto o restart de m3u8-emitter.
