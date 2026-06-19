---
name: FOX/FOX+ URL filler bridge
description: IDs 24/25 publish a "RECONECTANDO · Media TV" HLS filler the instant the live FFmpeg dies, then splice back without wipe so clients never lose signal during re-scrape.
type: feature
---

Scope: only IDs 24 (FOX+ URL) and 25 (FOX URL).

Architecture (Option A — persistent HLS publisher):
- Single shared HLS directory per slug (`live/foxmas/`, `live/fox/`).
- When LIVE ffmpeg dies (any non-manual cause), `fox-filler.js::startFiller` spawns
  `ffmpeg -re -stream_loop -1 -i assets/filler-fox.mp4 -c copy -f hls ...` writing
  to the SAME playlist with `append_list+discont_start+epoch` numbering.
- Codecs of the filler match the LIVE profile exactly: 720p · 29.97fps · libx264
  main · CBR 2000k · AAC 128k · 44.1kHz stereo. No re-encode → near-zero CPU.
- When the new LIVE ffmpeg is about to spawn (HLS-output branch), the wipe is
  SKIPPED if filler was active and `stopFillerAndWait` is awaited first, so the
  playlist keeps growing and clients never reload the manifest.
- Manual stop kills filler too (both /api/stop branches).

The previous `filler-bridge-rejection` memory still applies to ALL OTHER channels
(no freeze-frame bridges anywhere else). This is an explicit, scoped exception
for 24/25 only, because those use TDMax short tokens that 404 within 30-60 min.

Filler asset lives at `assets/filler-fox.mp4` (~7.5 MB, 30 s loop, regen with
`assets/make-filler-fox.sh`). The setup-vps/update flow must ship it.
