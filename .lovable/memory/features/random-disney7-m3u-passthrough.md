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
- `/api/emit` acepta nuevos params: `passthrough`, `extra_headers`, `referer`, `user_agent`.
- Cuando `passthrough === true`: strip de flags de transcoding y reemplazo por `-c copy -bsf:a aac_adtstoasc`.
- `referer` custom sobreescribe `refererDomain`/`originDomain`.
- `user_agent` custom sobreescribe `sessionUserAgent`.
- `extra_headers` se concatenan a `combinedHeaders` (excepto Referer/Origin/User-Agent/Authorization que se manejan aparte).
- ID válido ampliado de 0-18 a 0-19.

## Frontend
- `M3U_FILE_PROCESSES = new Set([19])`.
- Estado `m3uPayloads`: `{fileName, url, referer?, userAgent?, headers}`.
- `parseM3uContent()` parsea `#EXTVLCOPT:http-referrer/user-agent/header=K:V` y toma primera URL http(s) como source.
- En modo passthrough, FFmpeg requiere que el origen sea H.264/AAC compatible con HLS, sino falla.

## Database
- Migración 20260429: amplió `emission_processes_id_check` a `id <= 19` e insertó fila 19.
