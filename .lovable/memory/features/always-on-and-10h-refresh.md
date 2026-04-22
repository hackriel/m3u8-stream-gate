---
name: always-on y refresh 10h
description: Switch always_on por canal que sobrevive reinicios del servidor y refresca URL cada 10 horas
type: feature
---
Columnas en emission_processes: `always_on` (bool), `last_refresh_at` (timestamptz).
- Endpoint POST /api/always-on { process_id, enabled } toggle, inicializa last_refresh_at al activar.
- Al iniciar el server: NO se resetea estado de filas existentes (solo INSERT de filas faltantes 0-15). Tras 8s relanza always_on=true (escalonados 2.5s); scrapeados via autoRecoverChannel, manuales via /api/emit con source_url guardado.
- Scheduler cada 5min revisa always_on y si last_refresh_at > 10h hace stop interno (internal_refresh:true) + relanzar con URL fresca.
- TIGO URL (id 12) excluido (depende de OBS local).
- Stop manual del usuario desactiva always_on. Stop con internal_refresh:true NO lo desactiva.
