---
name: FUTV ALTERNO (canal eventual con URL dinámica)
description: Proceso ID 17. Acepta URL del player TDMax pegada por el usuario, extrae channel_id y scrapea M3U8. Comparte slug HLS 'FUTV' con ID 11 (mutex automático en server).
type: feature
---
- Tab "FUTV ALTERNO" (índice 17) para emisiones puntuales cuando TDMax saca señal alterna en eventos importantes (ej. partidos).
- Usuario pega URL completa tipo `https://www.app.tdmax.com/player?id=689b81b08f08c8be77f8eb43&type=channel`. Frontend extrae el `id` (24 hex) del query param y lo manda a `/api/local-scrape` con channel_id dinámico.
- También acepta el ID "pelado" (24 chars hex) por si el usuario solo copia eso.
- Salida HLS: `http://167.17.69.116:3001/live/FUTV/playlist.m3u8` (mismo slug que FUTV URL ID 11).
- BLOQUEO MUTUO en `/api/emit`: si FUTV URL (11) o FUTV ALTERNO (17) ya emite al slug 'FUTV', el otro NO puede arrancar (HTTP 409). Hay que detener el activo primero.
- Excluido del switch always-on y del refresh horario fijo (es manual/eventual).
- Frontend: input M3U8 es read-only; se autocompleta tras "🔄 Extraer".
