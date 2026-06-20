# pi5-cr-gateway

Convierte el Raspberry Pi 5 (en casa, IP residencial CR) en un **gateway
WireGuard** que el VPS usa **selectivamente** para que SOLO los canales
geo-bloqueados (Canal 6 URL · 15, FOX+ URL · 24, FOX URL · 25) salgan al CDN
con IP de Costa Rica. El resto del VPS sigue saliendo por su IP USA — el
túnel **no es la ruta por defecto**.

## Requisitos físicos

- Raspberry Pi 5 con Raspberry Pi OS **Bookworm 64-bit**.
- Conexión cableada (recomendado) a un router con **IP pública no-CGNAT**.
- Port forward UDP **51820** → IP local del Pi.
- Upload ≥ 15 Mbps (los 3 canales son ~6 Mbps cada uno en el peor caso).

## Orden de arranque (desde cero)

En el Pi (como root):

```bash
sudo bash pi5-cr-gateway/uninstall.sh   # solo si venís de un estado roto
sudo bash pi5-cr-gateway/install.sh
```

`install.sh` imprime al final:
- **IP pública del Pi** (la usás como `PI_ENDPOINT` en el VPS).
- **Pubkey del Pi** (la pegás como `PI_PUBKEY` en el VPS).

En el VPS (como root):

```bash
sudo PI_PUBKEY="<pubkey_pi>" \
     PI_ENDPOINT="<ip_publica_pi>:51820" \
     bash setup-vps-cr-wireguard.sh
```

Eso imprime la **pubkey del VPS**. Volvé al Pi:

```bash
sudo bash pi5-cr-gateway/add-vps-peer.sh <pubkey_vps>
```

Verificá:

```bash
sudo bash pi5-cr-gateway/status.sh       # en el Pi
curl -s http://localhost:3000/api/cr-tunnel/health   # en el VPS
```

En el dashboard, al levantar Canal 6 URL / FOX+ URL / FOX URL deberías ver
un badge **🇨🇷 IP CR · X.X.X.X** sobre la card del canal.

## Si algo sale mal

- `status.sh` no muestra handshake → revisar port-forward UDP/51820 del router
  y que el `PI_ENDPOINT` (IP pública del Pi) no haya cambiado.
- `/api/cr-tunnel/health` devuelve `wg_up:false` → revisar `wg show` en el VPS.
- Los canales USA empiezan a fallar tras correr el setup → el script del VPS
  protege con `Table = off`, no debería pasar. Si pasa, ejecutar:
  ```bash
  sudo systemctl stop wg-quick@wg0 cr-policy-routing
  ```
  para volver al estado previo y abrir un issue.