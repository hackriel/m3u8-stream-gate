---
name: always-on y refresh horario fijo
description: Switch always_on por canal que sobrevive reinicios; refresca URL en horarios fijos 00:00 y 05:00 hora Costa Rica
type: feature
---
Columnas en emission_processes: `always_on` (bool), `last_refresh_at` (timestamptz).
- Endpoint POST /api/always-on { process_id, enabled } toggle, inicializa last_refresh_at al activar.
- Al iniciar el server: NO se resetea estado de filas existentes. Tras 8s relanza always_on=true (escalonados 2.5s); IDs 12/16/18 se saltan (auto-arranque propio OBS); IDs 21/22/23 (SRT-ingest desde Pi5) se relanzan con payload `srt://obs` + `hls-local`.
- Scheduler refresh diario (3:00 AM CR): busca filas con always_on=true Y is_emitting=true. Excluye 12/16/18 (OBS local) y 21/22/23 (el Pi5 refresca su propio token TDMax). Guard 60 min vía last_refresh_at. Se ejecuta en **paralelo** (stagger 4s entre canales), no secuencial: antes el último canal esperaba N x 3 min.
- Tras la pausa de 3 min y el relanzamiento, hay **verificación post-refresh**: chequeos a 45s/90s/150s; si el canal no volvió, reintenta vía tryRelaunchAlwaysOnChannel.
- Watchdog always-on cada 2 min: la lista de IDs es **dinámica** (todas las filas con always_on=true en BD, excepto 12/16/18), con fallback a la lista fija 15/21/22/23/24/25/26. Maneja 13 en modo oficial (Bradmax) y 17/26 vía player_url.
- El bloqueo horario 1-5 AM del watchdog solo aplica a filas con `night_rest=true`; los demás canales pueden rescatarse a las 3-4 AM si el refresh falló.
- Stop manual del usuario desactiva always_on. Stop con internal_refresh:true NO lo desactiva.
