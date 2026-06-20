---
name: WireGuard Gateway CR (Pi 5)
description: VPS rutea tráfico TDMax/Teletica vía túnel WireGuard al Pi 5 en casa CR para evadir geo-block del CDN
type: feature
---
- Problema: CDN `cdn0x/cdn12.teletica.com` bloquean IPs fuera de CR con 403. Solución: rutear ese tráfico desde el VPS por WireGuard hacia un Pi 5 en casa con IP residencial CR.
- **Ruteo por UID, no por destino (Jun 2026)**: solo los FFmpegs de FOX URL (25), FOX+ URL (24), Canal 6 URL (15) y FOX+ ALTERNO (26) salen por el túnel. El resto del VPS (FUTV URL 11, TELETICA URL 13, TDMAS URL 14, SRT, etc.) sale por la IP del VPS y NO depende del Pi.
- Mecanismo: server.js spawnea esos FFmpegs como `runuser -u croute -- ffmpeg ...`. iptables `-m owner --uid-owner croute -j MARK --set-mark 0x77` marca los paquetes del UID; `ip rule fwmark 0x77 table cr_routed` los rutea por wg0. Constante `CR_TUNNEL_PROCESSES` en server.js + helper `wrapFfmpegForCrTunnel`.
- `cf.streann.tech` sigue ruteado por destino (ipset `cr_routed`) para que el login TDMax desde el VPS también vaya por CR. Los CDNs `cdn0x.teletica.com` ya NO se rutean por destino.
- Setup inicial: `pi5-wireguard-gateway/install.sh` (Pi) + `setup-vps-wireguard-client.sh` (VPS). Migración a UID-routing: `pi5-wireguard-gateway/migrate-to-uid-routing.sh` (VPS, idempotente).
- Service `cr-policy-routing.service` restaura ipset + mark por UID + mark por destino + rule + route al boot.
- Si el Pi se cae solo se afectan FOX/FOX+/Canal 6/FOX+ ALTERNO. Antes (Jun 2026 anterior) se caía también TELETICA/TDMAS/FUTV URL porque sus CDNs también estaban en el ipset.
- Requisitos: IP pública en casa CR (no CGNAT), port forward UDP/51820 al Pi, upload ≥15 Mbps.
- Subred WG: `10.77.0.0/24` (Pi=.1, VPS=.2). Puerto: UDP 51820.