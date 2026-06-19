#!/usr/bin/env bash
set -euo pipefail
FONT=/tmp/font.ttf
MONO=/tmp/fontmono.ttf
LOGO=/tmp/logo_360.png
OUT=/tmp/filler-fox.mp4

ffmpeg -y \
  -f lavfi -t 30 -i "color=c=0x07070f:s=1280x720:r=30000/1001" \
  -loop 1 -t 30 -i "$LOGO" \
  -f lavfi -t 30 -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
  -filter_complex "
    [0:v]format=yuv420p,
      drawbox=x=0:y=0:w=1280:h=720:color=0x0b0b18@1:t=fill,
      drawbox=x=0:y=0:w=1280:h=720:color=0x121226@0.5:t=fill,
      vignette=PI/4[bg];
    [1:v]format=rgba,
      scale=w='320+10*sin(2*PI*t/3)':h=-1:eval=frame:flags=lanczos[logo];
    [bg][logo]overlay=x='(W-w)/2':y='(H-h)/2-40':format=auto,
      drawtext=fontfile=${FONT}:text='RECONECTANDO':fontcolor=0xE6E6F2:fontsize=34:
        x=(w-text_w)/2:y=h/2+150:
        alpha='0.65+0.35*sin(2*PI*t/2)',
      drawtext=fontfile=${MONO}:text='S E Ñ A L   E N   V I V O':fontcolor=0x8b8ba8:fontsize=14:
        x=(w-text_w)/2:y=h/2+200,
      drawbox=x='iw/2-32':y='ih/2+248':w=10:h=10:color=0xff3355@1:t=fill:
        enable='lt(mod(t,1.2),0.4)',
      drawbox=x='iw/2-32':y='ih/2+248':w=10:h=10:color=0xff3355@0.15:t=fill:
        enable='gte(mod(t,1.2),0.4)',
      drawbox=x='iw/2-5':y='ih/2+248':w=10:h=10:color=0xff3355@1:t=fill:
        enable='lt(mod(t-0.2,1.2),0.4)',
      drawbox=x='iw/2-5':y='ih/2+248':w=10:h=10:color=0xff3355@0.15:t=fill:
        enable='gte(mod(t-0.2,1.2),0.4)',
      drawbox=x='iw/2+22':y='ih/2+248':w=10:h=10:color=0xff3355@1:t=fill:
        enable='lt(mod(t-0.4,1.2),0.4)',
      drawbox=x='iw/2+22':y='ih/2+248':w=10:h=10:color=0xff3355@0.15:t=fill:
        enable='gte(mod(t-0.4,1.2),0.4)',
      drawbox=x=40:y=680:w=1200:h=2:color=0x222238@1:t=fill,
      drawbox=x='40+mod(t*420,1360)-160':y=679:w=160:h=4:color=0xff3355@0.9:t=fill,
      drawtext=fontfile=${MONO}:text='MEDIA TV   LIVE':fontcolor=0x6e6e8a:fontsize=12:
        x=40:y=40,
      drawtext=fontfile=${MONO}:text='AUTO-RECOVERY':fontcolor=0x6e6e8a:fontsize=12:
        x=w-text_w-40:y=40,
      fps=30000/1001,format=yuv420p[v]
  " \
  -map "[v]" -map 2:a \
  -c:v libx264 -preset veryfast -profile:v main -level 4.0 \
  -b:v 2000k -minrate 2000k -maxrate 2000k -bufsize 4000k \
  -g 60 -keyint_min 60 -sc_threshold 0 -x264-params "nal-hrd=cbr" \
  -pix_fmt yuv420p -r 30000/1001 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart \
  "$OUT"
