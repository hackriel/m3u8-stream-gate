#!/usr/bin/env bash
# pi5-cr-gateway / add-vps-peer.sh
# Agrega (o actualiza) el peer del VPS en /etc/wireguard/wg0.conf y recarga.
#
# Uso (en el Pi, como root):
#   sudo bash pi5-cr-gateway/add-vps-peer.sh <vps_pubkey>

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "❌ Requiere root." >&2
  exit 1
fi

VPS_PUBKEY="${1:-}"
VPS_ENDPOINT="${2:-}"
if [[ -z "$VPS_PUBKEY" || -z "$VPS_ENDPOINT" ]]; then
  echo "Uso: $0 <vps_pubkey> <vps_ip_publica:51820>" >&2
  echo "Ejemplo: $0 abcd...= 216.152.154.29:51820" >&2
  exit 1
fi

WG_CONF=/etc/wireguard/wg0.conf
VPS_WG_IP=10.77.0.2/32

if [[ ! -f "$WG_CONF" ]]; then
  echo "❌ $WG_CONF no existe. Corré install.sh primero." >&2
  exit 1
fi

# Quitar bloque [Peer] anterior si existe (idempotencia)
awk -v RS='' -v ORS='\n\n' '!/^\[Peer\]/' "$WG_CONF" > "${WG_CONF}.tmp" || true
mv "${WG_CONF}.tmp" "$WG_CONF"

cat >> "$WG_CONF" <<EOF

[Peer]
# VPS (USA) — reverse tunnel: el Pi inicia el handshake hacia el VPS.
# Así no dependemos del port-forward del router Huawei de Telecable.
PublicKey           = $VPS_PUBKEY
Endpoint            = $VPS_ENDPOINT
AllowedIPs          = $VPS_WG_IP
PersistentKeepalive = 25
EOF

chmod 600 "$WG_CONF"

echo "[add-vps-peer] Recargando wg-quick@wg0 ..."
systemctl restart wg-quick@wg0
sleep 1
wg show wg0

echo "✅ Peer del VPS agregado. El Pi iniciará el handshake automáticamente en ~25s."