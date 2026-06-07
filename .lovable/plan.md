
## Objetivo

En el tab **TELETICA URL** (proceso 13), permitir elegir antes de iniciar entre:

- **Fuente Oficial** — URL directa `https://cdn01.teletica.com/TeleticaLiveStream/Stream/playlist_dvr.m3u8` con `Referer: https://bradmax.com/` (verificada HTTP 200, sin token, sin login).
- **Scraping (TDMax)** — flujo actual con login + `wmsAuthSign`.

Reglas de fallback:
- **Oficial cae → cambia automáticamente a Scraping** (manteniendo el mismo perfil de salida y destino HLS).
- **Scraping cae → NO promueve a Oficial**. Solo el usuario puede volver a seleccionar Oficial manualmente.

## Verificación previa

Antes de implementar, ya validé desde el VPS:
```
GET https://cdn01.teletica.com/TeleticaLiveStream/Stream/playlist_dvr.m3u8
Headers: Referer: https://bradmax.com/
→ 200 OK · Nimble/4.3.2 · master playlist con 4 variantes (720p/540p/360p/270p @ 29.97fps) · sin wmsAuthSign
```
Funciona. La CDN no exige token; solo valida `Referer = bradmax.com`. El Variant Pinning manual que ya existe en `server.js` (rama `hostname.includes('teletica.com')`) sigue aplicando y mantiene `nimblesessionid` sticky.

## Cambios

### 1. Frontend — `src/components/EmisorM3U8Panel.tsx`

En la tarjeta del proceso 13:
- Agregar selector segmentado **"Fuente: [Oficial] [Scraping]"** sobre el campo URL.
- Estado persistido en `localStorage` (`teletica13_source_mode`, default `'scraping'` para no cambiar comportamiento por defecto).
- Modo `oficial`:
  - Auto-rellenar `process.m3u8` con la URL fija de bradmax.
  - Ocultar/deshabilitar el botón "🔄 Teletica" (no hace falta scrapear).
  - Botón Iniciar envía `source_mode: 'official'` en `/api/emit`.
- Modo `scraping`: comportamiento actual sin cambios + envía `source_mode: 'scraping'`.
- Si el server reporta vía log un cambio automático a scraping, actualizar el toggle local a `scraping`.

### 2. Server — `server.js`

- **Aceptar `source_mode`** en `POST /api/emit`. Guardar en `teleticaSourceMode: Map<process_id, 'official'|'scraping'>`.
- **Headers FFmpeg (línea ~2903):** dentro de la rama `hostname.includes('teletica.com')`, distinguir por path:
  - `pathname.includes('/TeleticaLiveStream/')` → `Referer/Origin = https://bradmax.com/`
  - Resto (cdn02/cdn12 con `wmsAuthSign`) → `https://www.app.tdmax.com/` (actual).
- **Variant Pinning manual** para Teletica oficial: hacer que `needsTdmaxLikePinning` también incluya el host de bradmax-style (ya lo cubre `isTeleticaSource`).
- **Auto-recovery del proceso 13** (rama `CHANNEL_MAP[process_id]` ~línea 4671):
  - Si `teleticaSourceMode.get('13') === 'official'`:
    1. Loggear `⚠️ Fuente oficial falló — cambiando automáticamente a SCRAPING`.
    2. `teleticaSourceMode.set('13', 'scraping')`.
    3. Continuar con el flujo de scrape existente.
  - Si ya está en `'scraping'`: comportamiento actual (sin promover a oficial).
- **Endpoint nuevo `GET /api/teletica/source-mode`** que devuelve `{ mode: 'official'|'scraping' }` para que el frontend sincronice el toggle tras un fallback automático (poll cada 5s mientras emite).

### 3. Sin cambios

- DB / migraciones: no se requieren, el modo vive en memoria del server + localStorage del cliente.
- Otros canales (FUTV, TDMAS 1, FOX, etc.): intactos.
- Perfil de salida (720p / CBR 2000k), HLS slug `Teletica`, mutex con TELETICA SRT (21), watchdog, recovery circuit-breaker: intactos.

## Por qué es seguro

- La URL oficial ya devolvió 200 + master M3U8 válido desde el VPS — no es teoría.
- El cambio de header es **path-scoped** dentro de `teletica.com`: si por alguna razón se mete una URL `cdn02.teletica.com/TDMAX/...` en modo oficial (no debería pasar), el header sigue siendo `app.tdmax.com` y no rompe nada.
- El fallback es **unidireccional** (oficial→scraping) como pediste, así que scraping nunca se reemplaza solo.
- Si el modo oficial falla, el server simplemente cae al mismo flujo de recovery que hoy ya funciona para los demás canales TDMax.
