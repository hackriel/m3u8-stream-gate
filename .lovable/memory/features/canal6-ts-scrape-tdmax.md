---
name: Canal 6 TS — modo Scrapeo TDMax (Repretel 6) vía WireGuard CR
description: Canal 6 TS soporta dos modos (manual URL / scrape TDMax cuenta info@media.cr) con sub-tabs; el scrape usa el túnel WireGuard CR
type: feature
---
- Tab "Canal 6 TS" tiene sub-tabs **Manual URL** y **Scrapeo TDMax**. Solo un modo activo a la vez; activar uno desactiva el otro automáticamente en el servidor.
- Modo `scrape` llama a edge function `scrape-channel` con `channel_id='65d7aca4e4b0140cbf380bd0'` (Repretel 6) y `account='pi'` (`TDMAX_EMAIL_PI` / `TDMAX_PASSWORD_PI` = info@media.cr, misma cuenta que FOX/FOX+ URL).
- FFmpeg en el VPS lee la URL `cdn*.teletica.com` ruteada vía túnel WireGuard al Pi 5 en CR (mismo mecanismo de FOX URL / FOX+ URL). NO requiere cambios en `cr-routed-domains.txt` porque los dominios ya están en la lista.
- Estado persistido en `canal6-ts-state.json`: `{ mode, tdmaxChannelId, tdmaxAccount, lastScrapeAt, lastScrapeError, ... }`.
- Endpoints nuevos: `POST /canal6-ts/scrape-start` (scrapea + arranca), `POST /canal6-ts/scrape-now` (re-scrape manual). Los endpoints antiguos `/canal6-ts/start` y `/canal6-ts/stop` siguen para modo manual.
- Auto re-scrape: cada 30 min se chequea edad del último scrape; si > 4h, re-scrapea (token wmsAuthSign de TDMax caduca).
- Cuando FFmpeg del shared-encoder muere en modo scrape, re-scrapea antes de respawn (evita bucle 403/404 por token vencido).
- Al boot del server, si `enabled=true` y `mode='scrape'`, refresca URL antes de arrancar shared encoder.