---
name: FOX+ URL (ID 24) — scraping TDMax
description: ID 24 scrapea FOX+ vía edge function scrape-channel (channel 6a10a6a2350cb5151ab6ca8c) y emite al slug 'foxmas'; mutex con FOX+ SRT (22)
type: feature
---
- Channel TDMax ID: `6a10a6a2350cb5151ab6ca8c` (FOX+ → URL CDN `cdn12.teletica.com/FoxSport2/...`).
- Misma lógica que TELETICA URL (13): el hostname `*.teletica.com` activa `isTeleticaSource` → modo VLC-like (sin `-reconnect_at_eof`, solo demuxer HLS) + Variant Pinning manual + headers `Origin/Referer: https://www.app.tdmax.com/`.
- Slug HLS: `foxmas` (compartido con FOX+ SRT id 22) → mutex automático por slug + mutex explícito en frontend.
- Tab TIGO SRT (id 12) oculto definitivamente: HDCP del decoder bloquea Cam Link 4K. Auto-arranque también removido.