---
name: always-on y refresh horario fijo
description: Switch always_on por canal que sobrevive reinicios; refresca URL en horarios fijos 00:00 y 05:00 hora Costa Rica
type: feature
---
Columnas en emission_processes: `always_on` (bool), `last_refresh_at` (timestamptz).
- Endpoint POST /api/always-on { process_id, enabled } toggle, inicializa last_refresh_at al activar.
- Al iniciar el server: NO se resetea estado de filas existentes. Tras 8s relanza always_on=true (escalonados 2.5s); IDs 12 y 16 se saltan (auto-arranque propio).
- Scheduler cada 1 min: si crHour ∈ {0, 5} y crMinute < 5, busca filas con always_on=true Y is_emitting=true (esto último para no relanzar canales apagados manualmente). Guard de 60 min vía last_refresh_at evita doble disparo. Hace stop interno (internal_refresh:true) + relanzar con URL fresca.
- IDs 12 (TIGO URL), 16 (DISNEY 7 URL) y 17 (FUTV ALTERNO) excluidos del refresh y del switch always-on. 12/16 dependen de OBS local; 17 es eventual (se activa solo durante eventos especiales).
- Stop manual del usuario desactiva always_on. Stop con internal_refresh:true NO lo desactiva.
