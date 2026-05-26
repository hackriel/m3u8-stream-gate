---
name: always-on y refresh horario fijo
description: Switch always_on por canal que sobrevive reinicios; refresca URL en horarios fijos 00:00 y 05:00 hora Costa Rica
type: feature
---
Columnas en emission_processes: `always_on` (bool), `last_refresh_at` (timestamptz).
- Endpoint POST /api/always-on { process_id, enabled } toggle, inicializa last_refresh_at al activar.
- Al iniciar el server: NO se resetea estado de filas existentes. Tras 8s relanza always_on=true (escalonados 2.5s); IDs 12/16/18 se saltan (auto-arranque propio OBS); IDs 21/22/23 (SRT-ingest desde Pi5) se relanzan con payload `srt://obs` + `hls-local`.
- Scheduler refresh diario (3:00 AM CR): busca filas con always_on=true Y is_emitting=true. Excluye 12/16/18 (OBS local) y 21/22/23 (el Pi5 refresca su propio token TDMax). Guard 60 min vía last_refresh_at.
- Watchdog always-on cada 2 min (IDs **15, 21, 22, 23**): si always_on=true y el proceso está caído sin parada manual ni descanso nocturno (1-5 AM CR) → relanza. Para 15 usa source_url+rtmp de BD; para 21/22/23 usa payload SRT fijo. Esto mantiene el VPS "siempre receptivo" a la señal SRT que el Pi5 empuja 24/7, aunque el listener o ETAPA 2 mueran de madrugada.
- Stop manual del usuario desactiva always_on. Stop con internal_refresh:true NO lo desactiva.
