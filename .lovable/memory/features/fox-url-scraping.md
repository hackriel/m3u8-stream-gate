---
name: FOX URL (ID 25) — scraping TDMax
description: ID 25 scrapea FOX vía edge function scrape-channel (channel 664237788f085ac1f2a15f81) y emite al slug 'fox'; mutex con FOX SRT (23)
type: feature
---
- Channel TDMax ID: `664237788f085ac1f2a15f81` (canal "FOX" en TDMax — antes etiquetado como "Tigo Sports" en el edge function; renombrado a `FOX`).
- Misma lógica que FOX+ URL (24) / TELETICA URL (13): hostname `*.teletica.com` activa `isTeleticaSource` → modo VLC-like (sin `-reconnect_at_eof`) + Variant Pinning + headers TDMax.
- Slug HLS: `fox` (compartido con FOX SRT id 23) → mutex por slug + mutex explícito en frontend.
- Salida pública: `http://167.17.69.116:3001/live/fox/playlist.m3u8`.
- Recovery: NO usar Quick Retry con misma URL porque `wmsAuthSign` expira/queda 404 tras horas; ID 25 va directo a scraping fresco. Si watchdog detecta arranque colgado sin primer frame, mata el FFmpeg viejo, ignora su close tardío y encola scraping fresco inmediato. Circuit breaker no debe cortar FOX URL mientras `always_on` está activo.
- Para encontrar IDs nuevos: login a `https://cf.streann.tech/web/services/v3/external/login?r=61316705e4b0295f87dae396` y GET `/web/services/v3/user/channels/active?r=...&dt=web&id=<uid>&ln=es` con `Authorization: Bearer <accessToken>`.