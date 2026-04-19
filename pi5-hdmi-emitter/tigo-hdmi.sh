#!/bin/bash
# ═══════════════════════════════════════════════════════
#  Tigo HDMI → SRT (Cam Link 4K → VPS)
#  Captura HDMI 720p30 + audio ALSA y empuja SRT caller
# ═══════════════════════════════════════════════════════

VPS_HOST="${VPS_HOST:-167.17.69.116}"
VPS_PORT="${VPS_PORT:-9000}"
LATENCY_MS="${LATENCY_MS:-2000}"
VIDEO_DEV="${VIDEO_DEV:-/dev/video0}"
AUDIO_DEV="${AUDIO_DEV:-hw:1,0}"
STREAM_ID="${STREAM_ID:-tigo-cr}"

echo "[$(date -Iseconds)] Tigo HDMI emitter starting"
echo "  Video: $VIDEO_DEV"
echo "  Audio: $AUDIO_DEV"
echo "  Target: srt://${VPS_HOST}:${VPS_PORT}?streamid=${STREAM_ID}"

# Esperar que la Cam Link esté lista (tras boot/USB hot-plug)
for i in $(seq 1 30); do
  if [ -e "$VIDEO_DEV" ]; then break; fi
  echo "[$(date -Iseconds)] Esperando $VIDEO_DEV ($i/30)..."
  sleep 2
done

if [ ! -e "$VIDEO_DEV" ]; then
  echo "[$(date -Iseconds)] ERROR: $VIDEO_DEV no existe. Saliendo (systemd reintentará)."
  exit 1
fi

# Loop infinito: si ffmpeg cae (ej. VPS se reinicia), reintenta a los 2s
while true; do
  echo "[$(date -Iseconds)] Iniciando FFmpeg → SRT..."

  ffmpeg -hide_banner -loglevel warning -nostats \
    -thread_queue_size 1024 \
    -f v4l2 -input_format yuyv422 -framerate 30 -video_size 1280x720 -i "$VIDEO_DEV" \
    -thread_queue_size 1024 \
    -f alsa -ac 2 -ar 48000 -i "$AUDIO_DEV" \
    -c:v libx264 -preset veryfast -tune zerolatency \
    -profile:v main -level 4.0 \
    -b:v 2000k -maxrate 2000k -bufsize 4000k \
    -g 60 -keyint_min 60 -sc_threshold 0 \
    -pix_fmt yuv420p \
    -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -f mpegts \
    "srt://${VPS_HOST}:${VPS_PORT}?mode=caller&latency=${LATENCY_MS}&pkt_size=1316&streamid=${STREAM_ID}"

  EXIT=$?
  echo "[$(date -Iseconds)] FFmpeg salió con código $EXIT. Reintentando en 2s..."
  sleep 2
done
