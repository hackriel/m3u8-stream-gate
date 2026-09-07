---
name: Criterio de estabilidad suavizado (v2)
description: Etiquetas SANO/ATENCIÓN/INESTABLE usan mediana de 60s, histéresis y recuperaciones recientes, no muestras instantáneas
type: feature
---
`src/lib/streamHealth.ts` (`computeStreamHealthSmoothed`, usado en Home y Uptime):
- Mediana de ventana de 60s por canal, no la última muestra de FFmpeg.
- Umbrales: FPS <22 aviso / <15 crítico; speed fuera 0.92–1.12 aviso / fuera 0.85–1.25 crítico; Q >=31 aviso / >=36 crítico.
- Histéresis: subir de severidad exige 3 lecturas seguidas; bajar exige 6.
- Recuperaciones: solo cuentan las de los últimos 10 minutos (>=3 = crítico).
- Warm-up 25s tras arrancar: nunca marca crítico.
- DUP/DROP siguen excluidos del criterio.
