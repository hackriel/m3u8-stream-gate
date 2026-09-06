---
name: SRT Session Kill (SOURCE OFF = SOURCE DEAD)
description: Al perder frames SRT >8s se borra el HLS y se mata el FFmpeg listener para que cada emisión sea una sesión nueva
type: feature
---
- `SRT_FEED_LOSS_MS` (default 8000): ms sin frames para declarar la fuente SRT caída.
- Al dispararse: borra playlist.m3u8 + .ts del slug (XUI recibe 404 y salta a backup), luego mata el FFmpeg listener (SIGTERM, SIGKILL a los 3s) salvo parada manual.
- El auto-recovery levanta un listener NUEVO → socket, timestamps, cola MPEG-TS y numeración de segmentos limpios. Nunca se reutiliza estado de la sesión anterior.
- `SRT_FEED_LOSS_KILL=0` desactiva el kill y deja solo el borrado de playlist.
