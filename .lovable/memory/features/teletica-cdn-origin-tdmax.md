---
name: Teletica CDN requiere Origin tdmax.com
description: cdn02.teletica.com valida wmsAuthSign contra Origin/Referer https://www.app.tdmax.com — usar teletica.com devuelve 200 con chunks vacíos
type: feature
---
- Hostname `*.teletica.com` (Teletica URL ID 13 y demás flujos teletica): FFmpeg headers DEBEN enviar `Referer: https://www.app.tdmax.com/` y `Origin: https://www.app.tdmax.com`.
- Si se manda `teletica.com` como Origin, CDN responde 200 OK pero entrega chunks no reproducibles → "scrapea vivo pero no carga".
- Aplica también al keepAlive del playlist (server.js ~líneas 750-780).
