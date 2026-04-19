---
name: Tigo HDMI → SRT Ingest (Pi5 → VPS)
description: Proceso ID 12 captura Tigo Stick por HDMI con Cam Link 4K en Pi5 y envía SRT al VPS, reemplazando el scraping vía SOCKS5
type: feature
---

Proceso ID 12 (TIGO URL) opera en **modo HDMI** por defecto (`TIGO_USE_HDMI=true`):

**Hardware**: Tigo Stick → HDMI → Elgato Cam Link 4K (USB) → Raspberry Pi 5
**Pi5 (24/7)**: FFmpeg captura V4L2 + ALSA, encodea H264 720p30 CBR 2000k + AAC 128k @ 48kHz, empuja SRT caller saliente: `srt://167.17.69.116:9000?mode=caller&latency=2000&pkt_size=1316&streamid=tigo-cr`

**VPS arquitectura de 2 etapas (modo HDMI)**:
- **Etapa 1**: `startTigoHdmiIngest()` spawnea FFmpeg SRT listener en `0.0.0.0:9000?mode=listener` que escribe HLS crudo (`-c copy`) a `/tmp/tigo-buffer-12/buf.m3u8` (10s seg × 8 = ~80s buffer)
- **Etapa 2**: FFmpeg #2 (sin cambios desde modo proxy) lee `buf.m3u8` con `-re` y transcodea 720p CBR 2000k → `/live/Tigo/playlist.m3u8`

El switch entre modos pasa por la variable `isTigoHdmiMode = process_id === '12' && TIGO_USE_HDMI`. Cuando es true, se intercepta el spawn principal: NO se spawnea proxychains+CDN, se usa `startTigoHdmiIngest()` cuyo proceso se registra en `ffmpegProcesses` igual que el flujo normal (toda la lógica de cierre/recovery sigue funcionando).

**Métricas SRT en vivo**: `tigoSrtMetrics` (Map) parsea stderr de FFmpeg (`-stats`) buscando `frame=` y `bitrate=`. Endpoint `GET /api/tigo-srt-status` devuelve `{ enabled, listenerPort, connected, bitrateKbps, pktsLost, lastFrameAgeMs, sinceMs, bufferReady }`. `connected` es false si pasaron > 5s sin frames.

**Sin keep-alive en modo HDMI**: `startTigoKeepAlive()` solo se llama cuando NO es modo HDMI (no hay sesión nimblesessionid que mantener viva).

**Reversibilidad**: setear `TIGO_USE_HDMI=false` en systemd → vuelve a modo proxychains+CDN automáticamente. Microsocks del Pi5 (puerto 1080) sigue corriendo como respaldo.

**Variables systemd**: `TIGO_USE_HDMI=true`, `TIGO_SRT_PORT=9000`, `TIGO_SRT_LATENCY_MS=2000`.

**Firewall VPS**: `setup-vps.sh` ejecuta `ufw allow 9000/udp` automáticamente.
