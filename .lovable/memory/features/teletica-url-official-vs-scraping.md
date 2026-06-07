---
name: Teletica URL (ID 13) — selector oficial vs scraping
description: Toggle UI + lógica de fallback unidireccional para Teletica URL (proceso 13)
type: feature
---
- UI toggle en tab TELETICA URL (13): "Oficial (Bradmax)" vs "Scraping (TDMax)". Persistido en `localStorage` `teletica13_source_mode` (default `scraping`).
- Modo `official`: URL fija `https://cdn01.teletica.com/TeleticaLiveStream/Stream/playlist_dvr.m3u8`, FFmpeg envía `Referer/Origin: https://bradmax.com/` (path-scoped: `/TeleticaLiveStream/` dentro de `teletica.com`). Sin login, sin wmsAuthSign.
- Modo `scraping`: flujo TDMax histórico (login + token de 60s) usando `cdn02/cdn12.teletica.com` con `Referer/Origin: https://www.app.tdmax.com/`.
- Estado server-side: `teleticaSourceMode` Map en `server.js`. `/api/emit` acepta `source_mode` para persistirlo.
- Fallback **unidireccional**: si FFmpeg sale en modo `official`, el handler de recovery (rama `CHANNEL_MAP[process_id]`) flipea a `scraping` ANTES de llamar `autoRecoverChannel`. De `scraping` NUNCA se promueve a `official` — solo el usuario puede reseleccionarlo manualmente.
- Frontend sincroniza el toggle con el server vía poll cada 5s a `GET /api/teletica/source-mode` (para reflejar fallbacks automáticos).
- Variant Pinning manual sigue aplicando (cubre cualquier URL `teletica.com`) — mantiene `nimblesessionid` sticky para la sub-playlist.