## Objetivo

1. Replicar el toggle **Telecable (VPS)** que hoy tiene FOX URL (pid 25) en estos 5 canales, como modo **alterno** (sin quitar el modo actual):
   - Teletica URL (pid 13)
   - TDMas 1 URL (pid 14)
   - FUTV URL (pid 11)
   - Canal 6 URL (pid 15)
   - FOX+ URL (pid 24)
2. Descubrir los `content-id` de Telecable para cada canal de forma automática (no los tengo confirmados).
3. Arreglar el flicker del perfil de salida al pulsar **Emitir**.

---

## Backend (`server.js`)

### Generalización del módulo Telecable
- Cambiar `TELECABLE_PROCESSES = new Set(['25'])` → incluir `['11','13','14','15','24','25']`.
- Cambiar `TELECABLE_CONTENT_MAP` de mapeo fijo a **mapeo por patrones de nombre** (resilient a cambios de content-id):
  ```js
  const TELECABLE_CHANNEL_MATCHERS = {
    '11': { contentIds: ['FUTV'], namePatterns: [/futv/i] },
    '13': { contentIds: ['TELETICA','CANAL7','TELE7'], namePatterns: [/teletica/i, /canal\s*7/i] },
    '14': { contentIds: ['TDMAS','TDMAS1','TDMAS_1'], namePatterns: [/td\s*m[aá]s\s*1?/i] },
    '15': { contentIds: ['CANAL6','REPRETEL6'], namePatterns: [/canal\s*6/i, /repretel/i] },
    '24': { contentIds: ['FOXPLUS','FOX_PLUS','FOXMAS','FOX+'], namePatterns: [/fox\s*\+/i, /fox\s*plus/i, /foxm[aá]s/i] },
    '25': { contentIds: ['FOX'], namePatterns: [/^fox$/i] },
  };
  ```
- Refactor `telecableLoginAndResolve(pid)`: si el `content-id` exacto no aparece en `/api/playlist`, recorre `namePatterns` contra el campo `name`/`title` de cada canal y usa el primer match. Guarda el `content-id` resuelto en `telecableState` para reusarlo.
- Mantener compatibilidad de `TELECABLE_CONTENT_MAP` como fallback simple.

### Endpoint de descubrimiento (nuevo)
- `GET /api/telecable/channels` — fuerza un login (rate-limited) y devuelve `[{ contentId, name, quality }]` de toda la playlist. Sirve para verificar/corregir mapeos sin tener que ssh al VPS.

### Endpoints por canal (generalizar `/api/fox/*`)
- Renombrar internamente a `/api/telecable/:pid/source-mode` y `/api/telecable/:pid/refresh`.
- Mantener `/api/fox/source-mode` y `/api/fox/refresh-telecable` como **alias** que llaman a los genéricos con `pid=25` (no rompe nada que ya funciona).

### Persistencia y auto-recovery
- Generalizar el bloque `if (String(process_id) === '25' && isTelecableMode('25'))` en `autoRecoverChannel` a `if (isTelecableMode(process_id))`.
- Idem en `POST /api/emit`: el bloque que resuelve URL Telecable y salta el túnel CR (`isFoxTelecable`) pasa a chequear `isTelecableMode(process_id)` para cualquier pid.
- `wrapFfmpegSpawn` ya respeta `isTelecableMode(pid)` → false en `isViaCrTunnel`, así que sirve sin cambios.
- Keep-alive: extender el `skipKeepAliveForTelecable` a cualquier pid en modo Telecable.
- Persistir `source_mode` en `emission_processes` para los 5 pids nuevos (ya hay infraestructura).

---

## Frontend (`src/components/EmisorM3U8Panel.tsx`)

### Hook genérico
- Reemplazar `foxMode`/`foxTelecableInfo`/`handleFoxModeChange` por un hook reutilizable `useTelecableMode(pid, defaultMode)` que encapsule:
  - State `mode` + setter con POST a `/api/telecable/:pid/source-mode`.
  - Polling de `GET /api/telecable/:pid/source-mode` cada 10s.
  - `refresh()` que llama `POST /api/telecable/:pid/refresh`.
- Instanciar el hook una vez por canal Telecable (FUTV, Teletica, TDMas1, Canal6, FOX+, FOX).

### UI por canal
- Extraer el bloque visual actual del toggle FOX (líneas ~2035-2085) a un componente `<TelecableModeSelector pid={...} info={...} mode={...} onChange={...} onRefresh={...} alternateLabel="..." />` y reusarlo en los 6 paneles.
- Para Teletica/Canal 6 que ya tienen toggle `oficial / scraping`, agregar **una tercera opción**: `Telecable (VPS)`. Estado se vuelve `'official' | 'scraping' | 'telecable'`.
- Reglas de UI condicional ya existentes (mostrar/ocultar input URL, botón Obtener, badge CR) se generalizan checkeando `mode === 'telecable'` por pid.

### Persistencia
- `localStorage` keys: `telecableMode:<pid>` para cada uno.
- En Supabase: usar el mismo `emission_processes.source_mode` que ya existe para los 3 canales con toggle.

---

## Fix del flicker del perfil de salida

- Diagnóstico: al pulsar **Emitir**, el panel resetea el `outputProfile` local momentáneamente porque el efecto que sincroniza con el servidor lee el valor antes de que el POST `/api/emit` confirme. Mientras tanto se pinta "Balanceado" (default) y luego vuelve al perfil real.
- Fix: en el `onClick` del botón Emitir, congelar `optimisticProfile` durante la transición (`isEmitting` flag) y omitir el setter del efecto de sync cuando `isEmitting === true`. Sin cambios en backend.

---

## Verificación

1. Tras desplegar al VPS y `./update.sh`:
   - `curl http://VPS/api/telecable/channels` → revisar nombres reales y ajustar `TELECABLE_CHANNEL_MATCHERS` si algún patrón no matchea.
   - En el dashboard, cambiar cada canal a modo Telecable y emitir → un solo FFmpeg, sin túnel CR, log `📡 Telecable URL obtenida (contentId=...)`.
2. Click rápido en **Emitir** → el badge del perfil ya no parpadea.

---

## Archivos a modificar

- `server.js` — generalización Telecable + endpoint discovery + alias FOX.
- `src/components/EmisorM3U8Panel.tsx` — hook `useTelecableMode`, componente `<TelecableModeSelector>`, integración en 5 canales nuevos, fix flicker.
- `.lovable/memory/features/fox-url-telecable.md` — actualizar para reflejar que ya no es exclusivo de FOX.

## Riesgos

- **ContentIds incorrectos**: mitigado con el endpoint `/api/telecable/channels` + matcher por nombre. Si un canal no aparece en la playlist (no contratado en la cuenta secundaria), el modo Telecable falla con error claro y el usuario puede volver al modo actual.
- **Rate-limit del login**: 1 login compartido para todos los canales (la sesión Telecable es global). Voy a deduplicar para que múltiples pids reusen el mismo `phpsessid` cuando aún no expiró.
