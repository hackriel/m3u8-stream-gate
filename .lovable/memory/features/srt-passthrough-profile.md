---
name: SRT Passthrough Profile
description: Perfil 'passthrough' para SRT ingest (16/18/20/21/22/23) — copy v+a sin re-encode
type: feature
---
# Passthrough para SRT ingest

Perfil de salida 'passthrough' en `OUTPUT_PROFILES` (server.js). Cuando el canal SRT lo usa, `startSrtIngest` arma args con `-c:v copy -c:a copy -bsf:v h264_mp4toannexb` + HLS muxer (`hls_time=6`, mpegts). NO toca codec/bitrate/resolución — la señal sale del VPS exactamente como la manda OBS.

Ventajas vs re-encode:
- CPU ~3% por canal (vs 80-120% de libx264 veryfast 720p30).
- Cero generation loss (OBS NVENC → decode → libx264 introducía artefactos visibles en deportes).
- Sin saturación cuando hay múltiples SRT vivos en paralelo.

Requisitos OBS publisher: H264 main + AAC. Recomendado 720p · 2000-3000k CBR · keyframe 2s · 48kHz.

## Defaults
IDs 16/18/20/21/22/23 arrancan en 'passthrough' por defecto (`SRT_INGEST_DEFAULT_PASSTHROUGH_IDS` en server.js + `SRT_INGEST_INDEXES` en frontend). Si el usuario cambia el dropdown a normal/balanced/optimized se re-encodea normal.

## UI
La opción "Passthrough" sólo aparece en el dropdown "Formato de salida" de canales SRT. Para canales scrapeados (TDMax, etc.) el dropdown sigue mostrando sólo normal/balanced/optimized (necesitan re-encode para unificar fps/GOP).

## NO confundir con scraping
Scraping HLS sigue requiriendo re-encode (libx264) — el input no es realtime sino HTTP, y unifica fps/GOP para todos los canales. Passthrough sólo aplica al input SRT.