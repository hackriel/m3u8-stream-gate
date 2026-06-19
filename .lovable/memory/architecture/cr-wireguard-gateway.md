---
name: WireGuard Gateway CR (Pi 5)
description: VPS rutea tráfico TDMax/Teletica vía túnel WireGuard al Pi 5 en casa CR para evadir geo-block del CDN
type: feature
---
- Problema: CDN `cdn0x/cdn12.teletica.com` y `cf.streann.tech` bloquean IPs fuera de CR con 403, aunque scraping (login) sí pasa por edge function. Solución: rutear esos dominios desde el VPS por WireGuard hacia un Pi 5 en casa con IP residencial CR.
- Setup: `pi5-wireguard-gateway/install.sh` (corre en Pi 5, genera claves + config WG server + MASQUERADE) + `setup-vps-wireguard-client.sh` (corre en VPS, monta cliente WG con `Table=off` + ipset `cr_routed` + iptables mangle fwmark `0x77` + ip rule → tabla 200 default vía Pi).
- Dominios ruteados editables en `/etc/wireguard/cr-routed-domains.txt`; refresh DNS → ipset cada 5 min vía cron `/usr/local/bin/cr-routed-refresh.sh`.
- Service `cr-policy-routing.service` restaura mark+rule+route al boot (ip rule/route no son persistentes nativamente).
- Transparente para FFmpeg y server.js — NO requiere cambios de código.
- Requisitos: IP pública en casa CR (no CGNAT), port forward UDP/51820 al Pi, upload ≥15 Mbps.
- Subred WG: `10.77.0.0/24` (Pi=.1, VPS=.2). Puerto: UDP 51820.