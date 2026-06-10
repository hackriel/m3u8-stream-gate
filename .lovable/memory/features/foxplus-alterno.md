---
name: FOX+ ALTERNO (canal eventual con URL dinámica para FOX+)
description: Proceso ID 26. Acepta URL del player TDMax pegada por el usuario, extrae channel_id y scrapea M3U8 con cuenta info@media.cr. Comparte slug HLS 'foxmas' con FOX+ URL (24) y FOX+ SRT (22) — mutex automático.
type: feature
---
- Tab "FOX+ ALTERNO" (índice 26) para emisiones puntuales de FOX+ cuando TDMax saca señal alterna en eventos (clon de FUTV ALTERNO/17).
- Usuario pega URL tipo `https://www.app.tdmax.com/player?id=XXXXXXXXXXXXXXXXXXXXXXXX&type=channel` y "🔄 Extraer" llama `/api/local-scrape` con channel_id dinámico.
- Acepta también el ID hex de 24 chars pelado.
- Salida HLS: `http://167.17.69.116:3001/live/foxmas/playlist.m3u8` (mismo slug que FOX+ URL/24 y FOX+ SRT/22).
- Mutex tri-way en frontend + bloqueo automático por slug en `/api/emit`: si 22, 24 o 26 ya emite a 'foxmas', los otros 2 no pueden arrancar (HTTP 409). Hay que detener el activo primero.
- Cuenta TDMax: `info@media.cr` (PI_ACCOUNT_PROCESSES incluye '26'), igual que FOX+ URL/24.
- Auto-recovery: si cae, server re-scrapea con `player_url` guardada en `emission_processes.player_url`. Boot recovery y refresh 3:00 AM CR respetan always_on si hay player_url.
- Circuit breaker: bypass como 24/25 (tokens cortos pueden necesitar varios re-scrapes).
- Excluido de auto-arranque por defecto (eventual). Sólo always_on si el usuario ya extrajo una URL.
