---
name: Tigo CR HDMI Ingest Strategy
description: Captura HDMI Tigo CR vía Cam Link 4K en Raspberry Pi 5, transcode local 720p y push SRT al VPS
type: feature
---
Tigo Sports Costa Rica se ingesta por captura física HDMI: decoder Tigo → Elgato Cam Link 4K (USB 3.0) → Raspberry Pi 5 → FFmpeg → SRT al VPS.

Configuración FFmpeg en el Pi (/opt/tigo-srt.sh):
- Video input: `-f v4l2 -framerate 30 -video_size 1920x1080 -i /dev/video0` (Cam Link siempre entrega lo que le manda el HDMI; capturar a 30fps reduce carga USB sin pérdida porque la salida es 29.97)
- Audio input: `-f alsa -ac 2 -ar 48000 -i hw:C4K,0` (el nombre ALSA real del Cam Link 4K es `C4K`, NO `CamLink`)
- Filtro: `scale=1280:720,fps=29.97`
- Encoder actual: `libx264 -preset veryfast -tune zerolatency`, CBR 2000k, GOP 60, yuv420p. `h264_v4l2m2m` quedó descartado en Pi 5 por incompatibilidad práctica.
- Audio out: AAC 128k 48kHz stereo
- Salida: `srt://167.17.69.116:9000?streamid=tigo&mode=caller&latency=3000000&pkt_size=1316` MPEG-TS
- Lip-sync: NO usar parches de `-itsoffset` por segundos/milisegundos. Si FFmpeg con entradas V4L2+ALSA separadas pierde sincronía, migrar el Pi a GStreamer con `v4l2src do-timestamp=true` + `alsasrc do-timestamp=true` bajo un mismo pipeline/reloj, y fijar el Tigo Stick en HDMI fijo + PCM stereo 48k.

Servicio systemd `tigo-srt.service` con Restart=always, RestartSec=5. No depende de Windows ni OBS. Cumple el estándar 720p29.97 CBR 2000k del proyecto.
