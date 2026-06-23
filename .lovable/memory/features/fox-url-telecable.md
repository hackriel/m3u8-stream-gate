---
name: Telecable alternate mode (multi-channel)
description: Modo alternativo para FUTV (11), Teletica (13), TDMas1 (14), Canal 6 (15), FOX+ (24) y FOX URL (25) — login directo a la API de Telecable desde el VPS, sin túnel CR
type: feature
---

# Modo Telecable (multi-canal)

Toggle "Telecable (VPS)" disponible en los tabs URL: FUTV (11), Teletica (13), TDMas1 (14), Canal 6 (15), FOX+ (24), FOX (25). Gana sobre el modo oficial/scraping cuando está activo.

- `scraping` (default): flujo histórico del canal (TDMax + Pi5/CR, o lo que aplique).
- `telecable`: login directo a `https://api.srv.teleplus.c.mtvreg.com/api/device-login` desde el VPS, fetch de `/api/playlist`, búsqueda del canal por `content-id` (con fallback por patrones de nombre), URL HLS firmada consumida por FFmpeg directo. NO usa túnel CR.

## Por qué el login corre en el VPS y no en edge function

La URL devuelta por `/api/playlist` lleva `signature-ip` atado a la IP que hizo el login. Si la edge function (IP Supabase) hace el login y luego FFmpeg en el VPS consume el URL, el CDN rechaza la firma. Por eso `telecableLoginAndResolve()` corre en `server.js`.

## Credenciales

Secrets de Lovable Cloud (también disponibles como env vars en el VPS):
- `TELECABLE_DEVICE_ID` (deviceId permanente del pairing iOS, ej. `632426890`)
- `TELECABLE_DEVICE_PASSWORD` (devicePassword permanente, ej. `65ow2qcq0t6t6klasr1z`)

Username/password del usuario (`3737604` / `3737604`) NO se usa — el pairing ya consumió esa credencial.

## Refresh strategy

- Reactivo: en `autoRecoverChannel` si `isTelecableMode(pid)` → relogin antes de reintentar.
- Proactivo: `setInterval(60_000)` revisa si `signature-expiration - now < 24h` → relogin silencioso.
- Rate-limit: máximo 1 relogin cada 20s por proceso (`TELECABLE_MIN_RELOGIN_INTERVAL_MS`).
- Sin fallback automático a scraping: si telecable falla, el circuit breaker existente detiene el ciclo y el usuario debe elegir modo manualmente.

## Estado y persistencia

- `telecableSourceMode` (Map): pid → mode, persistido en `emission_processes.source_mode`.
- `telecableState` (Map): pid → `{ phpsessid, url, expiresAt, contentId, quality, fetchedAt }` — SOLO memoria (efímero).
- `TELECABLE_CHANNEL_MATCHERS`: por pid, lista de `contentIds` candidatos + `namePatterns` regex fallback. Tolerante a renombres del CDN.
- `lastTelecablePlaylist`: caché de la última playlist resuelta (5 min), usada por el endpoint discovery.

## Endpoints

- `GET /api/telecable/:pid/source-mode` — devuelve `{ mode, telecable: { content_id, quality, expires_at, expires_in_s }, last_login_failure_count }`.
- `POST /api/telecable/:pid/source-mode` body `{ mode }` — setea `telecable` o `scraping`.
- `POST /api/telecable/:pid/refresh` — fuerza relogin sin reiniciar FFmpeg.
- `GET /api/telecable/channels` — lista todos los canales de la playlist (para ajustar matchers).
- ALIASES legacy: `GET/POST /api/fox/source-mode`, `POST /api/fox/refresh-telecable` (pid 25).

## isViaCrTunnel override

`isViaCrTunnel(pid)` devuelve `false` para cualquier pid cuando `isTelecableMode(pid)`, para que `wrapFfmpegSpawn` NO use `runuser croute`. FFmpeg sale por la IP del VPS para coincidir con `signature-ip`.