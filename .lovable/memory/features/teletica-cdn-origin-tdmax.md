---
name: Teletica CDN requiere Origin tdmax.com
description: cdn02.teletica.com valida wmsAuthSign contra Origin/Referer https://www.app.tdmax.com — usar teletica.com devuelve 200 con chunks vacíos
type: feature
---
- Hostname `*.teletica.com` (Teletica URL ID 13 y demás flujos teletica): FFmpeg headers DEBEN enviar `Referer: https://www.app.tdmax.com/` y `Origin: https://www.app.tdmax.com`.
- Si se manda `teletica.com` como Origin, CDN responde 200 OK pero entrega chunks no reproducibles → "scrapea vivo pero no carga".
- Aplica también al keepAlive del playlist (server.js ~líneas 750-780).
- El master playlist viene con `wmsAuthSign?validminutes=1`. Si FFmpeg recarga el master cada pocos segundos, pierde la sesión y entra en loop `error=End of file` → watchdog mata a los 47s. Solución: resolver el master UNA vez en Node (rama "Variant Pinning manual" estilo Tigo) y pasarle a FFmpeg directamente la sub-playlist `chunks.m3u8` — la CDN devuelve `nimblesessionid` sticky y FFmpeg solo recarga la sub-playlist con sesión válida.
