---
name: SRT Feed-Loss Guard
description: Borra playlist+segmentos HLS cuando un canal SRT deja de recibir frames (evita loop del último fragmento en XUI)
type: feature
---
# SRT Feed-Loss Guard (server.js)

Causa raíz del "loop" en XUI: al cortar el publisher SRT (OBS/Pearl Nano) el FFmpeg listener NO muere (sigue escuchando el puerto). El playlist queda congelado con sus 8 últimos segmentos y `omit_endlist`, así que el player lo trata como live y reproduce esa ventana en bucle.

Fix: `setInterval` cada 3s recorre `ffmpegProcesses`; para pids SRT (`isSrtIngestProcess`) si `lastFrameTime` > `SRT_FEED_LOSS_MS` (default 12000, env override) borra `*.m3u8` y `*.ts` del slug → clientes 404 → caen a backup. Cuando vuelven los frames se limpia el flag (`srtFeedLossCleared`) y FFmpeg reescribe el playlist (append_list + epoch). `clearHlsSlugForPid` también resetea el flag.

No mata FFmpeg ni toca el listener SRT: la reconexión del publisher sigue siendo instantánea.
