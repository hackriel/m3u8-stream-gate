---
name: FOX URL fast-404 killer
description: IDs 24/25 mata FFmpeg al 2º "Failed to reload playlist" en 5s; salta watchdog 75s y va directo a scrape fresco invalidando lastKnownStreamState
type: feature
---
Para FOX URL (25) y FOX+ URL (24) — únicos canales con scrape directo a CDN
TDMax — el watchdog estándar (75s) deja a clientes con pantalla negra cuando
el token/sesión muere y la playlist responde 404.

Detector en server.js (stderr handler, junto al de Canal 6): al 2º
"Failed to reload playlist" dentro de 5s →
  - scrapeSessionCache.delete(process_id)
  - lastKnownStreamState.delete(process_id)  ← evita Quick Retry con URL muerta
  - quickRetryState.set(process_id, now)     ← fuerza full re-scrape inmediato
  - SIGTERM + SIGKILL@2s

Recovery (lógica existente) re-loguea TDMax y trae URL fresca en segundos
en vez de minutos. No aplicar a otros IDs scrapeados — usan otros CDNs.
