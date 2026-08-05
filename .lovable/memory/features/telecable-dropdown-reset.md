---
name: Telecable dropdown — limpieza de estado (Disney 7 / Disney 8)
description: Reglas de reset del dropdown Telecable en pids 0 y 10 tras detener o cambiar de canal/modo.
type: feature
---
- `stopEmit` limpia `m3u8` (local + DB) cuando el pid está en modo Telecable dropdown
  (pid 0 telecable/telecable_vlc, pid 10 telecable). La URL firmada muere con la sesión.
- Cambiar canal en el `<select>` limpia la URL resuelta y los mensajes de error.
- Botón 🧹 junto al dropdown: limpia canal seleccionado + URL resuelta.
- `switchDisneyMode()` gobierna los sub-tabs: `preventDefault`+`stopPropagation`,
  bloquea el cambio si isEmitiendo/starting/stopping, y limpia la URL del modo anterior.
- Lista de canales: reintento automático al volver al tab si el intento previo falló y
  pasaron >30s (`telecableChannelsAttemptedAtRef`).
