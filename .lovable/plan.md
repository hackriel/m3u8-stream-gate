
## 1. Nuevos tabs "Canal 8 URL" y "Canal 2 URL" (solo Telecable)

- Subir `NUM_PROCESSES` de 27 a 29.
- IDs nuevos:
  - `CANAL8_URL_INDEX = 27` → contentId `MULTIMEDIOS` ("MULTIMEDIOS"), slug HLS `Canal8`.
  - `CANAL2_URL_INDEX = 28` → contentId `CDR` ("CDR"), slug HLS `Canal2`.
- Como son canales **solo Telecable**, no se muestra el toggle "scraping vs telecable" — el modo queda fijado en `telecable` y se oculta el bloque de fuente alterna (igual que un canal normal pero sin opción de cambiar).
- URL m3u8 para compartir (igual que los demás):
  - Canal 8: `http://167.17.69.116:3001/live/Canal8/playlist.m3u8`
  - Canal 2: `http://167.17.69.116:3001/live/Canal2/playlist.m3u8`

### Cambios en código
- `EmisorM3U8Panel.tsx`:
  - `NUM_PROCESSES = 29`, agregar `CANAL8_URL_INDEX`, `CANAL2_URL_INDEX`.
  - Agregar entradas en `CHANNEL_CONFIGS`, `HLS_OUTPUT_PROCESSES`, mapa `hlsSlugs`, `TELECABLE_PIDS` (set base y array de defaults `localStorage`), default `telecableModes` = `'telecable'` para estos pids.
  - Forzar `telecable` (no permitir cambiar) en el bloque de selector y en el envío de `source_mode` al backend.
- `server.js`:
  - `TELECABLE_PROCESSES` += `'27','28'`.
  - `TELECABLE_CHANNEL_MATCHERS['27'] = { contentIds: ['MULTIMEDIOS'], namePatterns: [/multimedios/i] }`.
  - `TELECABLE_CHANNEL_MATCHERS['28'] = { contentIds: ['CDR'], namePatterns: [/^cdr$/i] }`.
  - `HLS_OUTPUT_PROCESSES.add('27','28')`.
  - `HLS_SLUG_MAP['27'] = 'Canal8'`, `HLS_SLUG_MAP['28'] = 'Canal2'`.
  - Agregar labels en los 2 `channelLabels` (líneas 3828 y 7015–7017).

## 2. Canal 6: cambiar de `.ts` passthrough a `.m3u8`

- El usuario ya tiene URL `.ts` (endpoint `/canal6.ts`). Como los demás canales se comparten como `.m3u8`, vamos a:
  - **Mantener** el endpoint `/canal6.ts` por compatibilidad temporal (no romper XUI existentes) pero
  - Mostrar como URL principal compartible en el UI: `http://167.17.69.116:3001/live/Canal6/playlist.m3u8` (ya está así para pid 15 en `hlsSlugs`). Esto ya es el comportamiento default actual — verifico que no haya nada que sobrescriba a `.ts` en el UI; si lo hay se quita.
- Confirmar que `CANAL6_URL_INDEX` arranca en modo `telecable` por default (como pediste, "ya sabes el contentId de telecable"): cambiar default a `telecable` y `TELECABLE_CHANNEL_MATCHERS['15']` ya tiene `REPRETEL6`, OK.

## 3. Disney 7 (ID 0): nuevo modo "Telecable" con dropdown de canales

Hoy Disney 7 (ID 0) es un passthrough de archivo M3U pegado por el usuario, slug HLS `Disney7`. Vamos a agregar un selector arriba del input:

- **Oficial** (default): el flujo actual exactamente igual (archivo M3U + perfil VLC-like).
- **Telecable**: muestra un `<select>` (dropdown) poblado por `GET /api/telecable/channels` (que ya existe) listando todas las señales `{ contentId, name }`. El usuario elige (ej. "TUDN"), oprime "Scrapear", el backend hace login Telecable y devuelve la URL HLS firmada. Se emite al **mismo slug `Disney7`** (la URL pública para compartir no cambia).

### Backend (`server.js`)
- Agregar pid `'0'` a `TELECABLE_PROCESSES` como pid especial:
  - `TELECABLE_CHANNEL_MATCHERS['0']` no se fija — el contentId viene dinámico desde el front (override).
  - Nuevo endpoint `POST /api/telecable/0/resolve` con body `{ contentId }` que llama `telecableLoginAndResolve(0, contentId)` y devuelve `{ success, url }`.
  - En el `start` handler, cuando `process_id === 0` y `source_mode === 'telecable'`, leer `telecable_contentId` del body, pasarlo a `telecableLoginAndResolve` y arrancar FFmpeg HLS hacia slug `Disney7` con el mismo perfil que Disney 7 SRT (re-encode normal — no el VLC M3U-file passthrough).
- Mutex: `Disney7` slug ya está compartido entre IDs 0/16/19. El mutex existente sigue funcionando — al arrancar Disney 7 en modo Telecable se cierran los otros 2 automáticamente. ✅ Sin conflicto adicional.

### Frontend (`EmisorM3U8Panel.tsx`)
- Para `processIndex === 0`, mostrar bloque "Modo Disney 7": botones **Oficial** | **Telecable**.
- Si Telecable: ocultar el input de archivo M3U y mostrar `<select>` con channels (cargados al cambiar a modo Telecable o al abrir el tab) + botón "🔄 Refrescar lista". Guardar `contentId` elegido en local state y enviarlo en el `start` payload.
- Si Oficial: UI actual sin cambios.
- Persistir modo en `localStorage` con key `disney7_0_source_mode`.

## 4. Layout de tabs: filas de 10 en desktop, scroll horizontal en mobile

En `TabsList` (línea 2680):
```text
mobile: inline-flex flex-nowrap min-w-max (scroll horizontal — se mantiene)
desktop (md:+): grid grid-cols-10 gap-1 min-w-0
```

Cambio concreto: reemplazar las clases md de `TabsList` por `md:grid md:grid-cols-10 md:gap-1` (en vez de `md:flex-wrap`), y quitar `md:justify-center` del wrapper para que el grid ocupe todo el ancho disponible. El tab UPTIME y los demás se insertan en orden y wrapean a la siguiente fila a partir del 11.

## Detalles técnicos

- **Mutex**: ningún slug nuevo colisiona — `Canal8` y `Canal2` son inéditos; Disney 7 Telecable reusa `Disney7` que ya tiene mutex multi-pid funcionando.
- **Recovery**: para pid 0 en modo Telecable, el auto-recovery debe re-resolver la URL usando el `contentId` cacheado en `telecableState.get('0')` (ya lo hace `telecableLoginAndResolve` por la lógica de `cached.contentId`). No requiere cambios adicionales.
- **Memoria**: actualizar `mem://index.md` y `.lovable/memory/` con notas sobre Canal 8/Canal 2 (Telecable-only) y Disney 7 dropdown Telecable.
- **No tocar**: `pi5-cr-gateway`, edge functions, output-profiles.json.

## Confirmación necesaria

Antes de implementar: ¿el modo Telecable de Disney 7 debe usar el **mismo perfil de encoding** que Disney 7 SRT (normal 720p CBR 2000k), o querés mantener el perfil VLC-like del modo Oficial? Por defecto voy con **normal** (mejor para HLS Telecable firmada). Avisame si preferís otra cosa.
