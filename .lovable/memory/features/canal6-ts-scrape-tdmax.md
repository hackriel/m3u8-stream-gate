---
name: Canal 6 — scraping TDMax via WireGuard CR (flujo estándar)
description: CANAL 6 URL (ID 15) usa el pipeline estándar de emission_processes con TDMax + cuenta info@media.cr ruteada por WireGuard CR
type: feature
---
**Estado actual (Jun 2026):** Canal 6 (ID 15 / "CANAL 6 URL") usa el flujo estándar idéntico a FOX URL y FOX+ URL:

- Frontend: entrada `CANAL 6 URL` en `CHANNEL_CONFIGS` con `scrapeFn: "scrape-channel"` y `channelId: "65d7aca4e4b0140cbf380bd0"` (Repretel 6 en TDMax). Sin presetUrl.
- Backend (`server.js`): `'15'` agregado a `CHANNEL_MAP` y a `PI_ACCOUNT_PROCESSES` → fuerza la cuenta `info@media.cr` (`TDMAX_EMAIL_PI`). El tráfico a `cdn*.teletica.com` ya sale por WireGuard CR a nivel OS.
- Logs, dropdown de perfil (Normal/Balanceada/Optimizada), uptime, recovery y métricas vienen "gratis" del pipeline estándar.

**Obsoleto / removido:** el tab independiente "Canal 6 TS" (endpoints `/canal6-ts/*`, archivo `canal6-ts-state.json`, shared encoder paralelo, endpoint `/canal6.ts`) fue eliminado por opaco y sin visibilidad (no aparecía en uptime, no mostraba logs). Borrar `canal6-ts-state.json` del VPS al desplegar.
