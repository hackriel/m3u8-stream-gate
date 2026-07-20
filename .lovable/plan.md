# Rebuild limpio del Pi 5 (gateway CR) + FUTV URL vía Pi

Objetivo: dejar el Pi 5 como un gateway CR **estable, predecible y auto-reparable**, con un solo script "todo en uno" que instale OS-tuning + WireGuard + proxy HTTP + watchdog + auto-restart, y agregar FUTV URL (ID 11) a la lista de canales que salen por CR.

## Parte A — Pi 5: instalación desde cero (por SSH)

### 1. Flashear OS recomendado (una sola vez, desde tu PC)
- **Raspberry Pi OS Lite (64-bit) Bookworm** — sin escritorio, menos servicios corriendo, más RAM libre, menos cosas que se cuelguen.
- Usar **Raspberry Pi Imager** y en "Advanced options":
  - Hostname: `pi5-cr-gw`
  - Enable SSH con clave pública (pegá tu `id_ed25519.pub`)
  - Usuario: `pi` + contraseña fuerte
  - WiFi: dejarlo en blanco (usaremos **cable ethernet obligatorio** — WiFi es la causa #1 de "inestabilidad no predecible")
  - Locale: America/Costa_Rica

### 2. Primer boot (5 min) — todo por SSH
```bash
ssh pi@<ip-local-del-pi>
sudo apt update && sudo apt -y full-upgrade
sudo apt -y install git curl chrony  # chrony = reloj estable
sudo timedatectl set-timezone America/Costa_Rica
sudo hostnamectl set-hostname pi5-cr-gw
```

### 3. Clonar repo y correr script único
```bash
cd ~
git clone https://github.com/hackriel/m3u8-stream-gate.git
cd m3u8-stream-gate
sudo bash pi5-cr-gateway/rebuild.sh
```

`rebuild.sh` (nuevo, consolidado — reemplaza `install.sh` + `setup-pi5.sh` viejos) hace **todo** de forma idempotente:

1. Deja limpio cualquier estado previo (`wg-quick@wg0 down`, borra iptables viejas).
2. Instala: `wireguard-tools`, `iptables-persistent`, `watchdog`, `unattended-upgrades`, `qrencode`, `curl`.
3. Habilita `ip_forward`, deshabilita IPv6 forwarding.
4. Genera claves WG (si no existen) y escribe `/etc/wireguard/wg0.conf` con MTU 1380 + NAT + FORWARD reglas.
5. Levanta `wg-quick@wg0` y lo habilita al boot.
6. **Proxy HTTP Pi** (Node) como `pi-proxy.service` con `Restart=always`, `RestartSec=5`, `WatchdogSec=30` (systemd mata + reinicia si el proxy se cuelga).
7. **Watchdog hardware BCM2712** (`/dev/watchdog`, timeout 15s) — reinicia el Pi si el kernel se congela.
8. **EEPROM**: `POWER_OFF_ON_HALT=0` + `WAKE_ON_GPIO=1` (vuelve solo tras corte de luz).
9. **unattended-upgrades** solo para *security* (no full-upgrade automático — evita sorpresas).
10. **Chrony**: reloj sincronizado (crítico para handshake WG).
11. **Reboot semanal programado** (`cron` domingos 4 AM CR) — limpia estado sin drama.
12. Detecta CGNAT y falla temprano con mensaje claro.
13. Imprime **pubkey + IP pública** al final.

### 4. En el VPS (una vez)
```bash
cd /root/m3u8-stream-gate
sudo PI_PUBKEY="<pubkey_del_paso_3>" \
     PI_ENDPOINT="<ip_publica_pi>:51820" \
     bash setup-vps-cr-wireguard.sh
```
Eso imprime la pubkey del VPS.

### 5. Volver al Pi y cerrar el peer
```bash
sudo bash pi5-cr-gateway/add-vps-peer.sh <pubkey_vps>
sudo bash pi5-cr-gateway/status.sh   # debe mostrar handshake < 2 min
```

### 6. Router
- **Port forward UDP 51820** → IP local del Pi.
- **DHCP reservation** para la MAC del Pi (que la IP local nunca cambie).

## Parte B — Cambios en el proyecto

Agregar **FUTV URL (ID 11)** al enrutado CR — cambios mínimos en `server.js`:

```diff
- const PROXY_PROCESSES = new Set(['15', '24', '25']);
+ const PROXY_PROCESSES = new Set(['11', '15', '24', '25']);
...
- const CHANNELS_VIA_PI_WG = new Set(['15', '24', '25']);
+ const CHANNELS_VIA_PI_WG = new Set(['11', '15', '24', '25']);
...
- const PI_ACCOUNT_PROCESSES = new Set(['15', '24', '25', '26']);
+ const PI_ACCOUNT_PROCESSES = new Set(['11', '15', '24', '25', '26']);
```

Con esto, FUTV URL (ID 11):
- Scrapea Telecable **desde la Pi** (IP CR) → devuelve URL firmada válida.
- FFmpeg sale por `runuser -u croute` → paquetes fwmark 0x77 → `wg0` → Pi → CDN.
- Si el túnel cae, **solo** FUTV/Canal 6/FOX/FOX+ fallan; el resto del VPS sigue normal.

## Parte C — Orden seguro de despliegue (sin caídas)

1. **En el Pi**: hacer todo A completo hasta que `status.sh` muestre handshake OK y `curl -x http://10.77.0.2:8888 https://ifconfig.me` desde el VPS devuelva IP CR.
2. **En el VPS** (todavía SIN el cambio de código):
   ```bash
   curl -s http://localhost:3001/api/cr-tunnel/health
   ```
   Confirmar `wg_up:true` y `ip_cr:"<IP CR>"`.
3. **Aplicar el cambio de `server.js`** (yo lo hago al aprobar el plan).
4. **En el VPS**:
   ```bash
   cd /root/m3u8-stream-gate
   sudo bash update.sh
   ```
   (el update reinicia el service; canales activos se recuperan solos).
5. **Verificación**: levantar FUTV URL en modo Telecable → debe salir badge 🇨🇷 IP CR.

## Notas técnicas

- **Por qué el Pi era impredecible**: mezcla de OS con escritorio + WiFi + falta de watchdog HW + `Restart=always` sin `WatchdogSec` (systemd no notaba cuelgues silenciosos) + reloj sin chrony (handshake WG falla si drift > 60s). `rebuild.sh` cierra los cinco frentes.
- **Nada se borra del VPS**: `setup-vps-cr-wireguard.sh` sigue igual (ya funciona). Solo se reusa.
- **Rollback**: si algo sale mal, `sudo systemctl stop wg-quick@wg0 cr-policy-routing` en el VPS + revertir 3 líneas en `server.js`. Cero riesgo para canales no-CR.

¿Aprobás? Cuando digas, creo `pi5-cr-gateway/rebuild.sh` y aplico el diff de `server.js`.
