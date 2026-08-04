---
name: Disney 8 (ID 10) — sub-tabs Oficial m3u pegado / Telecable dropdown
description: pid 10 replica el modo Telecable de Disney 7 pero emite al RTMP destino manual pegado por el usuario.
type: feature
---
- pid '10' agregado a TELECABLE_PROCESSES (server.js), SIN matcher fijo: contentId
  dinámico vía `telecable_content_id` en `/api/emit` y `/api/telecable/10/refresh`.
- pid 10 NO está en HLS_OUTPUT_PROCESSES → la salida sigue siendo el RTMP manual.
- UI (`EmisorM3U8Panel.tsx`): sub-tabs "🏛️ Oficial m3u pegado" (flujo M3U pegado
  histórico) y "📡 Telecable dropdown" (lista de canales Telecable). Estado en
  `disney8Mode` / `disney8ContentId` (localStorage `disney8_10_*`), mapeado a
  telecableModes[10] ('telecable' | 'scraping'). Sin back-sync desde el poll.
- Recovery: pid 10 está en MANUAL_URL_PROCESSES; en modo Telecable /api/emit
  re-resuelve la URL firmada igual que pid 0.
- Aparece en /uptime y en el tab UPTIME (id 10 = "Disney 8", color ámbar en Telecable).
