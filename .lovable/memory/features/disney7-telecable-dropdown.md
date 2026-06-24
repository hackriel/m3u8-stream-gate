---
name: Disney 7 — modo Telecable con dropdown
description: pid 0 acepta modo Telecable con contentId dinámico elegido en dropdown de canales.
type: feature
---
pid `'0'` está ahora en TELECABLE_PROCESSES. NO tiene matcher fijo: el
frontend pasa `telecable_content_id` en el body de `/api/emit` (Disney 7
Telecable mode). El backend lo persiste en `telecableState.get('0').contentId`
para que el auto-recovery reuse el mismo canal.

UI: selector "Oficial | Telecable" exclusivo del tab Disney 7. En modo
Telecable se carga `GET /api/telecable/channels` y se muestra un `<select>`
ordenado por name. El usuario elige → "Scrapear" llama
`POST /api/telecable/0/refresh { content_id }`. Slug de salida sigue siendo
`Disney7` (misma URL HLS pública, mutex compartido con pids 16/19).

Importante: el frontend SIEMPRE manda `source_mode` para pid 0 (telecable o
scraping) — sin esto, una sesión previa en 'telecable' persistida en la DB
rompería el modo Oficial.