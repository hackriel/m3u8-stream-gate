#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  🌐 WireGuard Gateway CR — Raspberry Pi 5
#  Convierte tu Pi en gateway VPN para que el VPS salga con tu
#  IP residencial costarricense (solo el tráfico Teletica/TDMax).
# ═══════════════════════════════════════════════════════════════

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

[ "$EUID" -eq 0 ] || fail "Ejecuta como root: sudo bash install.sh"

# ── Config ──
WG_PORT="${WG_PORT:-51820}"
WG_NET="10.77.0.0/24"
WG_SERVER_IP="10.77.0.1"
WG_CLIENT_IP="10.77.0.2"  # VPS
WG_IFACE="wg0"
WG_DIR="/etc/wireguard"

echo ""
echo "═══════════════════════════════════════════════"
echo "  🌐 WireGuard Gateway CR — Pi 5"
echo "═══════════════════════════════════════════════"
echo ""

# ── 1. Detectar interfaz WAN (la que tiene la default route) ──
WAN_IFACE=$(ip route show default | awk '/default/ {print $5; exit}')
[ -n "$WAN_IFACE" ] || fail "No pude detectar la interfaz WAN (¿el Pi tiene internet?)"
ok "Interfaz WAN detectada: $WAN_IFACE"

# ── 2. Instalar paquetes ──
echo "📦 Instalando WireGuard..."
apt update -qq
apt install -y wireguard wireguard-tools iptables qrencode curl >/dev/null
ok "WireGuard instalado"

# ── 3. Habilitar IP forwarding ──
echo "🔧 Habilitando IP forwarding..."
sysctl -w net.ipv4.ip_forward=1 >/dev/null
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
ok "IP forwarding activo"

# ── 4. Generar claves (idempotente) ──
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"
cd "$WG_DIR"

if [ ! -f server_private.key ]; then
  echo "🔐 Generando claves del servidor..."
  wg genkey | tee server_private.key | wg pubkey > server_public.key
  chmod 600 server_private.key
  ok "Claves del servidor generadas"
else
  warn "Claves del servidor ya existían — reutilizando"
fi

if [ ! -f client_vps_private.key ]; then
  echo "🔐 Generando claves del cliente VPS..."
  wg genkey | tee client_vps_private.key | wg pubkey > client_vps_public.key
  chmod 600 client_vps_private.key
  ok "Claves del cliente VPS generadas"
else
  warn "Claves del cliente VPS ya existían — reutilizando"
fi

SERVER_PRIV=$(cat server_private.key)
SERVER_PUB=$(cat server_public.key)
CLIENT_PRIV=$(cat client_vps_private.key)
CLIENT_PUB=$(cat client_vps_public.key)

# ── 5. Detectar IP pública ──
PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "")
if [ -z "$PUBLIC_IP" ]; then
  warn "No pude detectar IP pública. Tendrás que reemplazar <TU_IP_PUBLICA> manualmente."
  PUBLIC_IP="<TU_IP_PUBLICA>"
else
  ok "IP pública detectada: $PUBLIC_IP"
  # Verificar si parece CGNAT (rango 100.64.0.0/10)
  if echo "$PUBLIC_IP" | grep -qE '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; then
    warn "⚠️  Tu IP parece CGNAT — el port forward NO va a funcionar."
    warn "⚠️  Pide IP pública a tu ISP o usa Tailscale en lugar de WireGuard puro."
  fi
fi

# ── 6. Crear config del servidor ──
cat > "$WG_DIR/${WG_IFACE}.conf" << EOF
[Interface]
Address = ${WG_SERVER_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIV}
# NAT: el tráfico del VPS sale por la WAN del Pi con MASQUERADE
PostUp   = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -s ${WG_NET} -o ${WAN_IFACE} -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -s ${WG_NET} -o ${WAN_IFACE} -j MASQUERADE

[Peer]
# VPS DigitalOcean
PublicKey = ${CLIENT_PUB}
AllowedIPs = ${WG_CLIENT_IP}/32
EOF
chmod 600 "$WG_DIR/${WG_IFACE}.conf"
ok "Config del servidor escrita en $WG_DIR/${WG_IFACE}.conf"

# ── 7. Habilitar y arrancar servicio ──
systemctl enable wg-quick@${WG_IFACE} >/dev/null 2>&1
systemctl restart wg-quick@${WG_IFACE}
sleep 1
if wg show ${WG_IFACE} >/dev/null 2>&1; then
  ok "WireGuard activo en UDP/${WG_PORT}"
else
  fail "WireGuard no arrancó. Revisa: journalctl -u wg-quick@${WG_IFACE} -n 30"
fi

# ── 8. Generar config para el VPS ──
VPS_CONFIG="/root/vps-wireguard-client.conf"
cat > "$VPS_CONFIG" << EOF
[Interface]
# === Pegá este archivo en el VPS como /etc/wireguard/wg0.conf ===
# (lo hace automáticamente setup-vps-wireguard-client.sh)
Address = ${WG_CLIENT_IP}/24
PrivateKey = ${CLIENT_PRIV}
# Sin DNS — el VPS sigue usando su resolver normal
# Sin Table=auto — el ruteo selectivo lo maneja el script del VPS
Table = off

[Peer]
# Pi 5 en casa CR
PublicKey = ${SERVER_PUB}
Endpoint = ${PUBLIC_IP}:${WG_PORT}
AllowedIPs = ${WG_SERVER_IP}/32
PersistentKeepalive = 25
EOF
chmod 600 "$VPS_CONFIG"

echo ""
echo "═══════════════════════════════════════════════"
echo -e "${GREEN}  ✅ Pi 5 listo como gateway CR${NC}"
echo "═══════════════════════════════════════════════"
echo ""
echo "  📡 IP pública (endpoint):  ${PUBLIC_IP}:${WG_PORT}"
echo "  🔑 Server pubkey:          ${SERVER_PUB}"
echo "  🔑 Client (VPS) pubkey:    ${CLIENT_PUB}"
echo ""
echo "  ── PRÓXIMOS PASOS ──"
echo ""
echo "  1) En tu router casa: forward UDP/${WG_PORT} → IP del Pi"
echo "       (IP del Pi: $(hostname -I | awk '{print $1}'))"
echo ""
echo "  2) Copiá este archivo al VPS:"
echo "       scp ${VPS_CONFIG} root@<IP-VPS>:/root/"
echo ""
echo "  3) En el VPS, corré: sudo bash setup-vps-wireguard-client.sh"
echo ""
echo "  Verificar handshake (desde el Pi):"
echo "       sudo wg show"
echo ""
EOF
exit 0