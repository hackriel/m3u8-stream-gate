---
name: WireGuard Gateway CR (Pi 5)
description: VPS rutea tráfico TDMax/Teletica vía túnel WireGuard al Pi 5 en casa CR para evadir geo-block del CDN
type: feature
---
- Problema: CDNs `cdn0x/cdn12.teletica.com` y CloudFront Canal 6 bloquean IPs fuera de CR con 403/IP-locked tokens. Solución: rutear ese tráfico desde el VPS por WireGuard hacia un Pi 5 en casa con IP residencial CR.
- **Rebuild Jun 2026 (post-destrucción del scaffolding anterior)**. Lista blanca actual estricta: `CHANNELS_VIA_PI_WG = new Set(['15','24','25'])` (Canal 6 URL, FOX+ URL, FOX URL). NO incluye 26 (FOX+ ALTERNO).
- **Doble mecanismo de ruteo en el VPS (`Table = off` en wg0.conf, NUNCA toca la ruta default)**:
  1. **FFmpeg**: `wrapFfmpegSpawn(pid, args)` lanza como `runuser -u croute -- ffmpeg ...`. iptables `-m owner --uid-owner croute -j MARK --set-mark 0x77` → `ip rule fwmark 0x77 table 100` → `ip route default dev wg0 table 100`.
  2. **Scraping (login TDMax + lb + verify)**: `fetchWithOptionalProxy` con `localAddress: '10.77.0.2'`. `ip rule from 10.77.0.2 table 100` rutea esos sockets vía wg0. Reemplaza al SOCKS5/proxychains.
- `PROXY_PROCESSES = new Set(['15','24','25'])` en server.js controla qué scrapes usan el bind a 10.77.0.2.
- Scripts del repo (todo lo manual eliminado): `pi5-cr-gateway/{install,uninstall,add-vps-peer,status}.sh` + `pi5-cr-gateway/README.md` + raíz `setup-vps-cr-wireguard.sh`. Idempotentes. Setup imprime IP pública del Pi y pubkeys.
- Service `cr-policy-routing.service` aplica `iptables -m owner --uid-owner croute -j MARK`, `ip rule fwmark`, `ip rule from 10.77.0.2`, y `ip route default dev wg0 table cr_routed` al boot.
- Endpoint `GET /api/cr-tunnel/health` → `{ wg_up, cr_ip, last_check, channels }`. Polleado por el frontend cada 15s. Badge "🇨🇷 IP CR · X.X.X.X" o "⚠️ Túnel CR caído" en las cards de 15/24/25.
- **Canal 6 URL (15) tiene toggle Oficial/Scraping** (espejo del de Teletica). 'official' = URL pegada por el usuario (sin auto-rellenar). 'scraping' = TDMax. Persiste en `emission_processes.source_mode`. Endpoint `GET /api/canal6/source-mode`.
- Si el Pi se cae → solo fallan 15/24/25 + badge ámbar. Cero impacto en los demás canales (no hay `0.0.0.0/0` en AllowedIPs ni ruta default tocada).
- Requisitos físicos: IP pública en casa CR no-CGNAT (install.sh aborta si detecta 100.64.0.0/10), port-forward UDP/51820 al Pi, upload ≥15 Mbps.
- Subred WG: `10.77.0.0/24` (Pi=.1, VPS=.2). MTU 1380. PersistentKeepalive 25s. Puerto UDP 51820. Tabla de ruteo CR: id 100, nombre `cr_routed`. Usuario VPS: `croute` (system, nologin).