---
name: RANDOM Disney 7 (ID 19) — M3U passthrough
description: Tab que sube archivo .m3u con headers y emite -c copy al slug compartido Disney7
type: feature
---
## Resumen
Nuevo canal (ID 19) "RANDOM Disney 7" que recibe un archivo `.m3u` con `#EXTVLCOPT` (referer, user-agent, http-header) + URL, y lo emite en modo passthrough (-c copy, sin recodificar) a `/live/Disney7/playlist.m3u8`.

## Salida compartida con DISNEY 7 SRT (ID 16)
- Ambos comparten slug `Disney7` en `HLS_SLUG_MAP` (server.js).
- Mutuamente excluyentes: el frontend detecta si el otro está activo y lo detiene antes de iniciar.
- Misma lógica que FUTV (11/17/18) compartiendo slug `futv`.

## Backend (`server.js`)
- `/api/emit` acepta: `passthrough`, `passthrough_mode`, `extra_headers`, `referer`, `user_agent`.
- `passthrough_mode` ∈ {`rawvideo` (default UI), `copy`, `smart`, `transcode`}. Compat: `passthrough:true` sin mode → `rawvideo` para ID 19, `copy` para otros.
  - **`rawvideo`** (ÚNICO modo expuesto en UI desde Apr 2026): `-c:v copy` + `-c:a aac -b:a 128k -ar 48000 -ac 2 -aac_coder twoloop`. Resuelve "video sin audio" en XUI/IPTV Smarters Pro cuando origen viene en AC3/EAC3/MP2/HE-AACv2.
  - `copy` (legacy): `-c copy -bsf:a aac_adtstoasc`. Requiere AAC en origen.
  - `smart` (legacy): `detectSourceCodecs()` per-stream.
  - `transcode` (legacy): perfil estándar CBR 2000k 720p libx264 + AAC 128k.
- ID 19 hereda perfil VLC-like de Disney 7 (ID 0): `-re`, `max_reload=1000`, `m3u8_hold_counters=1000`, `-fflags +genpts`, `reconnect_at_eof + reconnect_streamed + reconnect_on_http_error 4xx,5xx + reconnect_delay_max 15`. Inyectados por rama dedicada `process_id === '19'` (NO se añade a `MANUAL_URL_PROCESSES` para evitar pre-check fetch sin headers + variant pinning agresivo).
- `referer` custom sobreescribe `refererDomain`/`originDomain`.
- `user_agent` custom sobreescribe `sessionUserAgent`.
- `extra_headers` se concatenan a `combinedHeaders` (excepto Referer/Origin/User-Agent/Authorization que se manejan aparte).
- ID válido ampliado de 0-18 a 0-19.

## Frontend
- `M3U_FILE_PROCESSES = new Set([19])`.
- Estado `m3uPayloads`: `{fileName, url, referer?, userAgent?, headers}`.
- `parseM3uContent()` parsea `#EXTVLCOPT:http-referrer/user-agent/header=K:V` y toma primera URL http(s) como source.
- UI: NO selector de modos (eliminado Apr 2026). Siempre envía `passthrough_mode: 'rawvideo'`.
- Requiere video H.264 en origen (audio puede ser cualquier códec, se re-encodea a AAC).

## Database
- Migración 20260429: amplió `emission_processes_id_check` a `id <= 19` e insertó fila 19.
