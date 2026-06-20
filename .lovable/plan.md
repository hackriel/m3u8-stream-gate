## Problema

El tab "Canal 6 TS" actual es una implementación paralela (estado en archivo JSON, endpoints `/canal6-ts/*`, ffmpeg propio) totalmente fuera del pipeline `emission_processes`. Por eso:

- No se ven logs en el visor estándar.
- No aparece en la lista de uptime.
- El status "Emitiendo" es opaco: si el ffmpeg interno no escribe al `.ts`, no hay forma de saberlo desde la UI.
- El sub-tab "Manual / Scrapeo" no se persiste bien.

## Solución: usar el mismo flujo que FOX URL / FOX+ URL

FOX URL ya hace exactamente lo que necesitamos: scrapea TDMax con WireGuard CR, corre dentro de `emission_processes`, muestra logs, tiene dropdown de perfil (Normal / Mejorado 720 / Optimizado 480) y aparece en uptime.

### Cambios

**1. Backend (`server.js`)**

- Borrar todo el bloque Canal 6 TS paralelo (~300 líneas):
  - `canal6TsState`, `CANAL6_TS_STATE_FILE`, `saveCanal6TsState`
  - `scrapeCanal6TsUrl`, `scheduleCanal6TsRescrape`
  - shared encoder `spawnCanal6TsSharedEncoder`
  - endpoints `/canal6-ts/status`, `/start`, `/scrape-start`, `/scrape-now`, `/stop`, `/profile`
  - generación dinámica del `.ts` por cliente en `/canal6.ts`
- En el scraper estándar del pipeline (el que ya usa FOX URL), cuando `channel_id === '65d7aca4e4b0140cbf380bd0'` (Canal 6), forzar `account: 'pi'` (cuenta `info@media.cr` / `TDMAX_EMAIL_PI`) y reusar la ruta WireGuard CR ya existente para hosts `teletica.com` / `tdmax.com`. Esto se aplica también al header spoofing Referer/Origin a `https://www.app.tdmax.com/` para CDN Teletica (ya existente, solo confirmamos que sigue activo).

**2. Frontend (`src/components/EmisorM3U8Panel.tsx`)**

- Borrar todo el state, polling, handlers y JSX del tab Canal 6 TS:
  - `canal6TsStatus`, `canal6TsInput`, `canal6TsBusy`, `canal6TsSubTab`, `canal6TsSubTabInitedRef`
  - `useEffect` de polling cada 5s a `/canal6-ts/status`
  - funciones `canal6TsStart`, `canal6TsScrapeStart`, `canal6TsScrapeNow`, `canal6TsStop`, `canal6TsSwitchProfile`
  - `TabsTrigger` "Canal 6 TS" (líneas ~2601-2625)
  - `TabsContent value="canal6-ts"` completo (líneas ~2786-3070)
- Convertir la entrada `CANAL 6 URL` (index 14) en un canal con scraping TDMax estándar:
  ```ts
  { name: "CANAL 6 URL", scrapeFn: "scrape-channel",
    channelId: "65d7aca4e4b0140cbf380bd0",
    fetchLabel: "🏛️ Repretel 6 (TDMax)" }
  ```
  (se quita el `presetUrl` cloudfront). Con esto el canal aparece automáticamente en logs, uptime, dropdown de perfil y todos los controles estándar — sin código nuevo.
- Quitar el bloque de auto-sync del `presetUrl` cloudfront para Canal 6 en `App.tsx` / el `useEffect` que lo restaura (líneas ~944, 992-993, 1070-1077, 1030-1033).

**3. Limpieza**

- Borrar `canal6-ts-state.json` del VPS (instrucción en respuesta).
- Actualizar memorias: `mem://features/canal6-ts-scrape-tdmax.md` → marcar OBSOLETA, reemplazar por nota corta "Canal 6 usa flujo estándar (channelId `65d7aca4…0bd0`, cuenta `pi`, WireGuard CR)".

## Resultado

El usuario verá Canal 6 como un canal más con su tab estándar: dropdown de calidad, panel de logs FFmpeg, badges de uptime, recovery automático, todo igual a FOX URL. La emisión sale al `.m3u8` HLS estándar (los clientes IPTV que esperaban `.ts` siguen funcionando porque la mayoría aceptan HLS; si necesitas mantener un endpoint `.ts` dedicado, lo evaluamos después).

## Pregunta antes de implementar

¿Confirmás que está bien dejar **solo la salida HLS estándar** (sin endpoint `.ts` dedicado)? Si tus clientes IPTV requieren forzosamente `.ts`, te aviso para mantener un proxy passthrough mínimo además del flujo estándar.