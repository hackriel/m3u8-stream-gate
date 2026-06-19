# WireGuard Gateway CR (Pi 5)

Convierte tu Raspberry Pi 5 en gateway VPN para que el VPS DigitalOcean
salga a internet **con tu IP residencial costarricense** — pero solo
para el tráfico de TDMax/Teletica. Todo lo demás del VPS (RTMP de salida,
dashboard, otros canales) sigue por su IP normal sin penalty.

## Arquitectura

```
[VPS] ──WireGuard túnel──> [Pi 5 casa CR] ──> Internet CR ──> Teletica/TDMax CDN
                                                                       │
                                                                       v
                                                          Responde a IP CR ✅
                                                          (no más 403 geo)
```

Solo el tráfico hacia `*.teletica.com` y `cf.streann.tech` sale por el túnel,
gracias a `ipset + iptables mangle + ip rule`. FFmpeg no se entera.

## Requisitos

- Raspberry Pi 5 con Raspberry Pi OS 64-bit, **conectado por ethernet** 24/7.
- **IP pública** en tu casa (no CGNAT). El instalador lo detecta y avisa.
- Port forward en tu router: **UDP 51820 → IP del Pi**.
- Upload de casa: 15–25 Mbps sostenido recomendado.

## Instalación

### 1. En el Pi 5 — comando único

Reemplazá `REEMPLAZAR-USER/REEMPLAZAR-REPO` por tu repo GitHub conectado a Lovable
(ej. `juanperez/m3u8-stream-gate`). Una sola línea, hace **reset + install**:

```bash
curl -fsSL https://raw.githubusercontent.com/REEMPLAZAR-USER/REEMPLAZAR-REPO/main/pi5-wireguard-gateway/bootstrap.sh \
  | sudo REPO_RAW=https://raw.githubusercontent.com/REEMPLAZAR-USER/REEMPLAZAR-REPO bash
```

Cada vez que actualicemos algo en el repo (cambios desde Lovable), corrés
**la misma línea** y el Pi queda al día. No hay que clonar nada ni copiar
archivos a mano.

Variables opcionales:
- `BRANCH=otra-rama` (default `main`)
- `SKIP_RESET=1` para no limpiar estado previo

Te imprime al final:
- IP pública detectada
- Ruta del archivo `vps-wireguard-client.conf` que tenés que copiar al VPS

### 2. Configurar port forward en el router

UDP/51820 → IP local del Pi 5 (el script te la muestra).

### 3. Copiar config al VPS

```bash
# Desde tu compu o desde el Pi:
scp /root/vps-wireguard-client.conf root@<IP-VPS>:/root/
```

### 4. En el VPS

```bash
sudo bash setup-vps-wireguard-client.sh
# o con ruta custom:
sudo bash setup-vps-wireguard-client.sh /root/vps-wireguard-client.conf
```

Al final hace una prueba `curl --interface wg0 https://api.ipify.org` y te
muestra la IP CR vs la IP del VPS. Si son distintas, todo OK.

### 5. Reiniciar el emisor

```bash
sudo systemctl restart m3u8-emitter
```

No hay que tocar `server.js` ni la edge function — el ruteo es transparente.

## Verificación

```bash
# En el VPS:
wg show                              # handshake activo
ip route show table 200              # ruta default vía Pi
ipset list cr_routed                 # IPs Teletica/Streann resueltas
curl --interface wg0 https://api.ipify.org   # tu IP CR
curl https://cdn02.teletica.com/      # debería pasar policy routing
```

## Agregar/quitar dominios

Editar `/etc/wireguard/cr-routed-domains.txt` en el VPS y correr:

```bash
sudo /usr/local/bin/cr-routed-refresh.sh
```

(También corre solo cada 5 min vía cron.)

## Si el túnel se cae

El emisor sigue funcionando — los GET a Teletica fallarán (timeout) hasta que
vuelva el handshake, y el sistema de auto-recovery existente reintentará.
WireGuard reconecta automáticamente (kernel-space + `PersistentKeepalive=25`).

Para fallback duro (preferir IP del VPS si el túnel está caído >5min), se puede
agregar después un watchdog que retire `ip rule` temporalmente — pedirlo si
lo necesitás.

## Desinstalar (rollback)

En el VPS:
```bash
sudo systemctl disable --now cr-policy-routing wg-quick@wg0
sudo ip rule del fwmark 0x77 table 200 2>/dev/null
sudo ip route flush table 200 2>/dev/null
sudo iptables -t mangle -F OUTPUT
sudo systemctl restart m3u8-emitter
```