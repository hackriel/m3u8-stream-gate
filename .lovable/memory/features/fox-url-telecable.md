---
name: FOX URL Telecable mode
description: Modo alternativo de FOX URL (pid 25) usando login directo a la API de Telecable desde el VPS, sin túnel CR
type: feature
---

# FOX URL (pid 25) — Modo Telecable

Piloto de tercera fuente para canales URL. Toggle dentro del tab FOX URL:

- `scraping` (default): scraping TDMax + FFmpeg vía `runuser croute` (túnel CR Pi5).
- `telecable`: login directo a `https://api.srv.teleplus.c.mtvreg.com/api/device-login` desde el VPS, fetch de `/api/playlist`, búsqueda del canal por `content-id` (`FOX`), URL HLS firmada consumida por FFmpeg directo. NO usa túnel CR.

## Por qué el login corre en el VPS y no en edge function

La URL devuelta por `/api/playlist` lleva `signature-ip` atado a la IP que hizo el login. Si la edge function (IP Supabase) hace el login y luego FFmpeg en el VPS consume el URL, el CDN rechaza la firma. Por eso `telecableLoginAndResolve()` corre en `server.js`.

## Credenciales

Secrets de Lovable Cloud (también disponibles como env vars en el VPS):
- `TELECABLE_DEVICE_ID` (deviceId permanente del pairing iOS, ej. `632426890`)
- `TELECABLE_DEVICE_PASSWORD` (devicePassword permanente, ej. `65ow2qcq0t6t6klasr1z`)

Username/password del usuario (`3737604` / `3737604`) NO se usa — el pairing ya consumió esa credencial.

## Refresh strategy

- Reactivo: en `autoRecoverChannel` si pid=25 y mode=telecable → relogin antes de reintentar.
- Proactivo: `setInterval(60_000)` revisa si `signature-expiration - now < 24h` → relogin silencioso.
- Rate-limit: máximo 1 relogin cada 20s por proceso (`TELECABLE_MIN_RELOGIN_INTERVAL_MS`).
- Sin fallback automático a scraping: si telecable falla, el circuit breaker existente detiene el ciclo y el usuario debe elegir modo manualmente.

## Estado y persistencia

- `telecableSourceMode` (Map): pid → mode, persistido en `emission_processes.source_mode`.
- `telecableState` (Map): pid → `{ phpsessid, url, expiresAt, contentId, quality, fetchedAt }` — SOLO memoria (efímero).
- `TELECABLE_CONTENT_MAP`: `{ '25': 'FOX' }` — extensible a otros canales (Canal 6, Teletica, FUTV, FOX+, TDmas) cuando se valide el piloto.

## Endpoints

- `GET /api/fox/source-mode` — devuelve `{ mode, telecable: { content_id, quality, expires_at, expires_in_s }, last_login_failure_count }`.
- `POST /api/fox/refresh-telecable` — fuerza relogin sin reiniciar FFmpeg (botón Refrescar en UI).

## isViaCrTunnel override

`isViaCrTunnel(pid)` devuelve `false` para pid 25 cuando está en modo telecable, para que `wrapFfmpegSpawn` NO use `runuser croute`. FFmpeg sale por la IP del VPS para coincidir con `signature-ip`.