---
name: Pantalla pública /uptime
description: Ruta /uptime sin contraseña con relojes de uptime rotativos; layout según forma de pantalla (TV 2x2, tablet cuadrada 1), params ?count y ?rotate
type: feature
---
- `/uptime` va FUERA de PasswordGate (todo lo demás sigue con contraseña).
- Lee `emission_processes` directo por Supabase cada 5s; muestra solo `emit_status` running/starting; uptime = now - start_time.
- Slots automáticos: <640px → 1; ratio ≥1.5 y ancho ≥1100 → 4 (2x2); ratio ≥1.5 → 2; cuadrado/tablet → 1.
- Rotación de página cada 10s (`?rotate=segundos`), override de cantidad con `?count=N` (máx 8).
- Oculta los mismos pids ocultos del dashboard (1-9, 19).
