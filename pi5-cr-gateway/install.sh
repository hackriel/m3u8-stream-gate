#!/usr/bin/env bash
# pi5-cr-gateway / install.sh
# Convierte el Raspberry Pi 5 en un gateway WireGuard residencial CR para que
# el VPS pueda rutear selectivamente el tráfico de Canal 6 / FOX / FOX+ por la
# IP de Costa Rica. Idempotente: se puede correr varias veces sin romper nada.
#
# Uso (en el Pi, como root):
#   sudo bash pi5-cr-gateway/install.sh
#
# Después: copiar la pubkey impresa al VPS, correr setup-vps-cr-wireguard.sh
# allá, y luego volver al Pi y ejecutar:
#   sudo bash pi5-cr-gateway/add-vps-peer.sh <vps_pubkey>

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "❌ Este script debe correr como root (sudo)." >&2
  exit 1
fi

WG_DIR=/etc/wireguard
KEY_DIR=$WG_DIR/keys
WG_CONF=$WG_DIR/wg0.conf
WG_PORT=51820
WG_SUBNET=10.77.0.0/24
PI_WG_IP=10.77.0.1/24

echo "════════════════════════════════════════════════════════════"
echo "  pi5-cr-gateway — install"
echo "════════════════════════════════════════════════════════════"

echo "[1/8] apt update + paquetes..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard-tools iptables iptables-persistent qrencode curl ca-certificates

echo "[2/8] Habilitando ip_forward..."
install -d /etc/sysctl.d
cat > /etc/sysctl.d/99-cr-gw.conf <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=0
EOF
sysctl --system >/dev/null

echo "[3/8] Detectando interfaz WAN..."
WAN_IF=$(ip -4 route show default | awk '/default/{print $5; exit}')
if [[ -z "${WAN_IF}" ]]; then
  echo "❌ No se pudo detectar la interfaz WAN. ¿El Pi tiene internet?" >&2
  exit 1
fi
echo "    WAN_IF = $WAN_IF"

echo "[4/8] Generando keys del Pi (si no existen)..."
install -d -m 700 "$KEY_DIR"
if [[ ! -f "$KEY_DIR/pi.key" ]]; then
  umask 077
  wg genkey | tee "$KEY_DIR/pi.key" | wg pubkey > "$KEY_DIR/pi.pub"
  chmod 600 "$KEY_DIR/pi.key" "$KEY_DIR/pi.pub"
fi
PI_PRIV=$(cat "$KEY_DIR/pi.key")
PI_PUB=$(cat "$KEY_DIR/pi.pub")

echo "[5/8] Escribiendo $WG_CONF ..."
# PostUp/PostDown: NAT del túnel → WAN. Sin esto el tráfico WG no sale a internet.
cat > "$WG_CONF" <<EOF
# Generado por pi5-cr-gateway/install.sh
[Interface]
Address    = $PI_WG_IP
ListenPort = $WG_PORT
PrivateKey = $PI_PRIV
MTU        = 1380

PostUp   = iptables -t nat -C POSTROUTING -s $WG_SUBNET -o $WAN_IF -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s $WG_SUBNET -o $WAN_IF -j MASQUERADE
PostUp   = iptables -C FORWARD -i %i -o $WAN_IF -j ACCEPT 2>/dev/null || iptables -A FORWARD -i %i -o $WAN_IF -j ACCEPT
PostUp   = iptables -C FORWARD -i $WAN_IF -o %i -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -i $WAN_IF -o %i -m state --state RELATED,ESTABLISHED -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s $WG_SUBNET -o $WAN_IF -j MASQUERADE 2>/dev/null || true
PostDown = iptables -D FORWARD -i %i -o $WAN_IF -j ACCEPT 2>/dev/null || true
PostDown = iptables -D FORWARD -i $WAN_IF -o %i -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true

# Los [Peer] del VPS se agregan con add-vps-peer.sh <vps_pubkey>
EOF
chmod 600 "$WG_CONF"

echo "[6/8] Habilitando wg-quick@wg0 ..."
systemctl daemon-reload
systemctl enable wg-quick@wg0 >/dev/null
systemctl restart wg-quick@wg0
sleep 1

echo "[7/8] Detectando IP pública del Pi..."
PUB_IP=$(curl -fsS --max-time 6 https://api.ipify.org || curl -fsS --max-time 6 https://ifconfig.me || echo "")
if [[ -z "$PUB_IP" ]]; then
  echo "⚠️  No se pudo detectar IP pública. Verificá conectividad."
else
  # Detectar CGNAT (rango 100.64.0.0/10 = 100.64.0.0 - 100.127.255.255)
  IFS=. read -r o1 o2 _ _ <<< "$PUB_IP"
  if [[ "$o1" == "100" && "$o2" -ge 64 && "$o2" -le 127 ]]; then
    echo "❌ IP pública detectada en rango CGNAT ($PUB_IP)." >&2
    echo "   No vas a poder recibir conexiones entrantes UDP/$WG_PORT." >&2
    echo "   Pedile IP pública real al ISP o usá Tailscale Funnel como plan B." >&2
    exit 2
  fi
fi

echo "[8/8] Resumen..."
cat <<EOF

════════════════════════════════════════════════════════════
  ✅ pi5-cr-gateway listo
════════════════════════════════════════════════════════════

  Interfaz WAN.............. $WAN_IF
  WireGuard ifaz............ wg0
  IP WG del Pi.............. $PI_WG_IP
  Puerto UDP escuchando..... $WG_PORT

  >>> IP PÚBLICA DEL PI5: ${PUB_IP:-DESCONOCIDA} <<<
  Usá esta IP (más :$WG_PORT) como Endpoint del peer en el VPS.

  >>> PUBKEY DEL PI (pegar en setup-vps-cr-wireguard.sh) <<<
  $PI_PUB

SIGUIENTE PASO:
  1) En el VPS, correr:
       sudo PI_PUBKEY="$PI_PUB" \\
            PI_ENDPOINT="${PUB_IP:-IP_DEL_PI}:$WG_PORT" \\
            bash setup-vps-cr-wireguard.sh
     Eso te imprime la pubkey del VPS.

  2) Volver al Pi y correr:
       sudo bash pi5-cr-gateway/add-vps-peer.sh <vps_pubkey>

  3) Verificar handshake:
       sudo bash pi5-cr-gateway/status.sh

ROUTER:
  Hacer port-forward UDP/$WG_PORT → IP local del Pi.

EOF