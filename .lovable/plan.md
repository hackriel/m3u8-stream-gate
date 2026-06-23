## Objetivo

Agregar una **tercera fuente alternativa** ("Telecable") al canal **FOX URL (pid 25)**, sin tocar nada del scraping CR actual. Si Telecable cae y `always_on` está activo, el sistema debe relogarse, traer un URL fresco y reiniciar FFmpeg automáticamente.

```text
FOX URL (pid 25)
├── Tab "Scraping" (actual, sale por túnel CR Pi5) ← intacto
└── Tab "Telecable" (nuevo, sale por IP del VPS)   ← se construye
```

## Alcance del piloto

Solo pid 25 (FOX). Si funciona limpio, se replica en Canal 6, Teletica, FUTV, FOX+, TDmax (tabla `TELECABLE_CONTENT_MAP` ya queda preparada para extender).

## Cambios

### 1. Edge function nueva: `telecable-stream`

`supabase/functions/telecable-stream/index.ts`

- Input: `{ content_id: 'FOX', quality?: 40 }`
- Hace `GET /api/device-login` con `TELECABLE_DEVICE_ID` + `TELECABLE_DEVICE_PASSWORD` (env)
- Hace `GET /api/playlist?PHPSESSID=…&quality=…`
- Busca canal por `content_id`, devuelve:
  ```json
  { "url": "https://stream.srv.telecable…", "expires_at": 1782799260, "phpsessid": "…" }
  ```
- 401/status:0 → `{ error: 'login_failed' }` con HTTP 502 para que el VPS sepa diferenciar de error de red.

### 2. `server.js` (VPS)

**Estado en memoria + persistencia (replica patrón Teletica):**
```js
const foxSourceMode = new Map(); // '25' → 'scraping' | 'telecable'
const TELECABLE_CONTENT_MAP = { '25': 'FOX' }; // extensible
const TELECABLE_REFRESH_MARGIN_S = 3600;       // refresh 1h antes de expirar
```

**`/api/emit` (pid 25):**
- Acepta `source_mode in {scraping, telecable}` y `telecable_quality` (default 40).
- Persiste en `emission_processes.source_mode`.
- Si `telecable`: invoca edge function, guarda URL firmado y `expires_at` en memoria (NO en DB — la firma es efímera y atada a IP), arranca FFmpeg directo sin pasar por wrapper `croute`.

**Auto-recuperación (3 puntos del recovery loop existente):**
- Si modo `telecable` y FFmpeg sale con código de error, o stall del watchdog, o quedan <30 min de firma → **forzar relogin** (nueva llamada edge function), reemplazar URL, restart FFmpeg.
- Si edge function falla 3x seguidas (con backoff 30s): `emit_status='error'`, `emit_msg='Telecable login falló'`. El circuit breaker existente (max 6 fallos) detiene el ciclo. NO se cae a `scraping` automáticamente: el usuario elige.

**Refresh proactivo:**
- Loop `setInterval(60_000)` revisa procesos con `source_mode='telecable'` activos. Si `expires_at - now < TELECABLE_REFRESH_MARGIN_S` → relogin + restart suave (sin contar como recovery).

**FFmpeg:**
- Mismo perfil 720p CBR 2000k 29.97fps actual.
- Headers `User-Agent` iOS app + `Cookie: PHPSESSID=…`. (Confirmado funcional desde shell del sandbox.)

**No tocar:**
- Wrapper `croute` / CHANNELS_VIA_PI_WG (sigue aplicando cuando modo = `scraping`).
- `scrape-channel` edge function (sigue siendo el flujo TDMax).

### 3. UI — `EmisorM3U8Panel.tsx`

Dentro de la card FOX URL (pid 25):

```text
┌─ Fuente ────────────────────────────┐
│ [ Scraping ] [ Telecable ]          │ ← tabs estables, memoized
└─────────────────────────────────────┘

Si tab = Telecable:
  Calidad: [ 40 ▼ ]   (10, 20, 30, 40, 50)
  Botón "Refrescar URL ahora"          (opcional, debug)
  Badge: "🟢 Vence en 23h 14m"
```

- Estado `foxSourceMode` (key localStorage `fox_25_source_mode`).
- Poll `/api/fox/source-mode` cada 5s con patrón anti-overwrite (mismo de Teletica).
- Tokens semánticos para colores (sin hardcode).

### 4. Memoria

Crear `mem://features/fox-url-telecable.md`: piloto pid 25, login VPS-direct (no CR), refresh @ expire-1h, mutex con tab Scraping (un solo modo activo).

Actualizar `mem://index.md` con la nueva referencia.

## Lo que NO se construye en este piloto

- Replicar Telecable en otros canales (queda para fase 2 tras validar FOX).
- Selector de URL alterna manual (Telecable siempre auto-loguea).
- Caché de PHPSESSID compartida entre procesos (cada canal hace su login propio — son <100ms y evita interferencia).

## Detalles técnicos clave

- **IP de firma**: la URL viene atada a `signature-ip`. El sandbox Lovable y el VPS tienen IPs distintas → la edge function debe correr en el contexto donde luego se consume. ✅ Cumplido: edge function corre en infra Supabase (IP estable), el FFmpeg consume desde VPS. Mientras la firma sea válida para *cualquier IP del cliente HTTP del CDN*, funciona. **Riesgo a verificar en el piloto**: si el CDN exige que el GET venga desde la misma IP que vio la API, la edge function deberá ser llamada *desde el VPS hacia el VPS* (server.js implementa el login él mismo en vez de invocar edge function). Plan B ya previsto: si en pruebas falla, mover la lógica de login a `server.js` (10 líneas, mismo `fetch`).
- **Secrets**: `TELECABLE_DEVICE_ID`, `TELECABLE_DEVICE_PASSWORD` ya guardados.
- **Rate limit**: máximo 1 relogin cada 20s por proceso para no parecer abuso.
- **Logging**: prefijo `[telecable:25]` en stderr para filtrar.

## Orden de implementación

1. Crear edge function `telecable-stream` y probarla con curl.
2. Wiring en `server.js` (estado + /api/emit + recovery hooks + refresh loop).
3. UI: tabs + selector calidad + badge expiración.
4. Memoria + README.
5. Verificación end-to-end con FOX URL en preview.
