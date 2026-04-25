---
name: HLS Live-Edge Anti-Rebuffer
description: Configuración HLS para evitar que IPTV Smarters Pro se atrase eternamente — segmentos cortos + playlist corto + delete_segments
type: feature
---
Para evitar el comportamiento de "el player se atrasa y nunca se pone al día" en IPTV Smarters Pro y similares, los canales scrapeados/HLS (IDs 0, 5, 10, 11, 13, 14, 15, 17) usan perfil LIVE-EDGE BALANCEADO en el output HLS:
- `-hls_time 2` (segmentos de 2s para recuperación rápida)
- `-hls_list_size 6` (12s de buffer visible máximo)
- `-hls_flags delete_segments+independent_segments+omit_endlist+discont_start` (borra .ts viejos, mantiene live, marca discontinuidad al reiniciar)
- `-hls_allow_cache 0` (no cachear, siempre live)
- NO usar `append_list` para forzar sesión fresca en cada arranque

Efecto: si el player se atrasa >12s, el segmento viejo ya no existe en disco → 404 → el player salta automáticamente al live edge. Trade-off: micro-brincos de 2-3s en caídas reales de red >12s, sin pantalla negra ni crashes.

NO aplicar a SRT (IDs 12, 16, 18) — esos los emite el usuario desde su PC vía OBS y mantienen `hls_time=4, hls_list_size=6, append_list+omit_endlist`.

Bloque relevante en server.js: rama `else if (isHlsOutput)` dentro del builder de ffmpegArgs (~línea 2542).
