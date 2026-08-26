---
name: Contador de visores en /uptime
description: Badge con ojo + número de visores por canal en /uptime, alimentado por /api/viewers del VPS (IP+UA únicos en 45s sobre /live/<slug>)
type: feature
---
- `server.js` registra cada request a `/live/<slug>/*.m3u8|*.ts` (y `/canal6.ts`) como visor: clave `IP|user-agent`.
- Un visor cuenta si fue visto en los últimos `VIEWER_TTL_MS` (default 45000).
- Endpoint `GET /api/viewers` → `{ by_slug, by_pid, total, ttl_ms }`; `by_pid` usa `HLS_SLUG_MAP`.
- `/uptime` consulta `/api/viewers` cada 5s y muestra badge (ojo izquierda, número derecha) arriba a la derecha de cada tarjeta. Fuera del VPS muestra `—`.
