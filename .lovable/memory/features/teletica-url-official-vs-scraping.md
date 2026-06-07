---
name: Teletica URL (ID 13) — selector oficial vs scraping
description: Toggle UI + lógica de fallback unidireccional para Teletica URL (proceso 13)
type: feature
---
- UI toggle en tab TELETICA URL (13): "Oficial (Bradmax)" vs "Scraping (TDMax)". Persistido en `localStorage` `teletica13_source_mode` (default `scraping`).
- Modo `official`: URL fija `https://cdn01.teletica.com/TeleticaLiveStream/Stream/playlist_dvr.m3u8`, FFmpeg envía `Referer/Origin: https://bradmax.com/` (path-scoped: `/TeleticaLiveStream/` dentro de `teletica.com`). Sin login, sin wmsAuthSign.
- Modo `scraping`: flujo TDMax histórico (login + token de 60s) usando `cdn02/cdn12.teletica.com` con `Referer/Origin: https://www.app.tdmax.com/`.
- Estado server-side: `teleticaSourceMode` Map en `server.js` + columna persistida `emission_processes.source_mode` (default `'scraping'`). `/api/emit` acepta `source_mode` y `setTeleticaSourceMode` escribe a DB (fire-and-forget) para sobrevivir reinicios. Al boot, el server carga el modo desde DB.
- Fallback **unidireccional**: si FFmpeg sale en modo `official`, TODOS los caminos de recovery flipean a `scraping` ANTES de llamar `autoRecoverChannel`:
  - Recovery completo principal (rama `CHANNEL_MAP[process_id]`, ~línea 4735).
  - Quick Retry fallback (3 puntos: emit falla, sin URL guardada, excepción ~líneas 4707/4715/4722).
  De `scraping` NUNCA se promueve a `official` — solo el usuario puede reseleccionarlo manualmente.
- Refresh diario 3:00 AM CR y boot-recovery always-on para pid 13: si modo === `official`, relanzar con `TELETICA_OFFICIAL_URL` vía `/api/emit` (NO `autoRecoverChannel` — eso forzaría scraping).
- Frontend sincroniza el toggle con el server vía poll cada 5s a `GET /api/teletica/source-mode` (para reflejar fallbacks automáticos).
- Variant Pinning manual sigue aplicando (cubre cualquier URL `teletica.com`) — mantiene `nimblesessionid` sticky para la sub-playlist.