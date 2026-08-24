---
name: Módulo de Diagnóstico de Streaming y Red
description: diagnostics.js (router /api/diag) + página /diagnostico para medir causa raíz de pérdida de frames RTMP/SRT
type: feature
---
Backend: `diagnostics.js` montado en `server.js` como `app.use('/api/diag', diagnosticsRouter)`.
Todo es READ-ONLY: nunca modifica sysctl, firewall, nginx, ffmpeg ni red. Solo lee y recomienda.

Endpoints: `/server`, `/nic`, `/sysctl`, `/sockets`, `/ffmpeg`, `/ingest`, `/ports`, `/mtu` (ping DF binario),
`/mtr` y `/route-compare` (VPS→tu red vs VPS→a.rtmp.youtube.com), `/iperf/status|server|run`,
`/stress/start|state|stop` (escalera TCP + UDP 1→10 Mbps), `/summary`, `/verdict` (probabilidades solo si hay evidencia).

Frontend: `src/pages/Diagnostics.tsx` en las rutas `/diagnostico` y `/diagnostics` (dentro de PasswordGate), enlazado desde el header del panel.

Dependencias del VPS (instalar manualmente): `apt install -y iperf3 mtr-tiny ethtool net-tools`.
Para el stress test hay que correr `iperf3 -s -p 5201` en la PC/red del encoder y poner su IP pública en el panel.
